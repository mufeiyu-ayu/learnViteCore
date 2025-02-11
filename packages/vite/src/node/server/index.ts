import path from 'node:path'
import { execSync } from 'node:child_process'
import type * as net from 'node:net'
import type * as http from 'node:http'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { performance } from 'node:perf_hooks'
import type { Http2SecureServer } from 'node:http2'
import connect from 'connect'
import corsMiddleware from 'cors'
import colors from 'picocolors'
import chokidar from 'chokidar'
import type { FSWatcher, WatchOptions } from 'dep-types/chokidar'
import type { Connect } from 'dep-types/connect'
import launchEditorMiddleware from 'launch-editor-middleware'
import type { SourceMap } from 'rollup'
import type { Matcher } from 'picomatch'
import picomatch from 'picomatch'
import type { CommonServerOptions } from '../http'
import {
  httpServerStart,
  resolveHttpServer,
  resolveHttpsConfig,
  setClientErrorHandler,
} from '../http'
import type { InlineConfig, ResolvedConfig } from '../config'
import { isDepsOptimizerEnabled, resolveConfig } from '../config'
import {
  diffDnsOrderChange,
  isInNodeModules,
  isObject,
  isParentDirectory,
  mergeConfig,
  normalizePath,
  promiseWithResolvers,
  resolveHostname,
  resolveServerUrls,
  setupSIGTERMListener,
  teardownSIGTERMListener,
} from '../utils'
import { getFsUtils } from '../fsUtils'
import { ssrLoadModule } from '../ssr/ssrModuleLoader'
import { ssrFixStacktrace, ssrRewriteStacktrace } from '../ssr/ssrStacktrace'
import { ssrTransform } from '../ssr/ssrTransform'
import { ERR_OUTDATED_OPTIMIZED_DEP } from '../plugins/optimizedDeps'
import { getDepsOptimizer, initDepsOptimizer } from '../optimizer'
import type { BindCLIShortcutsOptions } from '../shortcuts'
import { bindCLIShortcuts } from '../shortcuts'
import { CLIENT_DIR, DEFAULT_DEV_PORT } from '../constants'
import type { Logger } from '../logger'
import { printServerUrls } from '../logger'
import {
  createNoopWatcher,
  getResolvedOutDirs,
  resolveChokidarOptions,
  resolveEmptyOutDir,
} from '../watch'
import { initPublicFiles } from '../publicDir'
import { getEnvFilesForMode } from '../env'
import type { FetchResult } from '../../runtime/types'
import { ssrFetchModule } from '../ssr/ssrFetchModule'
import type { PluginContainer } from './pluginContainer'
import { ERR_CLOSED_SERVER, createPluginContainer } from './pluginContainer'
import type { WebSocketServer } from './ws'
import { createWebSocketServer } from './ws'
import { baseMiddleware } from './middlewares/base'
import { proxyMiddleware } from './middlewares/proxy'
import { htmlFallbackMiddleware } from './middlewares/htmlFallback'
import {
  cachedTransformMiddleware,
  transformMiddleware,
} from './middlewares/transform'
import {
  createDevHtmlTransformFn,
  indexHtmlMiddleware,
} from './middlewares/indexHtml'
import {
  servePublicMiddleware,
  serveRawFsMiddleware,
  serveStaticMiddleware,
} from './middlewares/static'
import { timeMiddleware } from './middlewares/time'
import type { ModuleNode } from './moduleGraph'
import { ModuleGraph } from './moduleGraph'
import { notFoundMiddleware } from './middlewares/notFound'
import { errorMiddleware, prepareError } from './middlewares/error'
import type { HMRBroadcaster, HmrOptions } from './hmr'
import {
  createHMRBroadcaster,
  createServerHMRChannel,
  getShortName,
  handleHMRUpdate,
  updateModules,
} from './hmr'
import { openBrowser as _openBrowser } from './openBrowser'
import type { TransformOptions, TransformResult } from './transformRequest'
import { transformRequest } from './transformRequest'
import { searchForWorkspaceRoot } from './searchRoot'
import { warmupFiles } from './warmup'

export interface ServerOptions extends CommonServerOptions {
  /**
   * Configure HMR-specific options (port, host, path & protocol)
   */
  hmr?: HmrOptions | boolean
  /**
   * Do not start the websocket connection.
   * @experimental
   */
  ws?: false
  /**
   * Warm-up files to transform and cache the results in advance. This improves the
   * initial page load during server starts and prevents transform waterfalls.
   */
  warmup?: {
    /**
     * The files to be transformed and used on the client-side. Supports glob patterns.
     */
    clientFiles?: string[]
    /**
     * The files to be transformed and used in SSR. Supports glob patterns.
     */
    ssrFiles?: string[]
  }
  /**
   * chokidar watch options or null to disable FS watching
   * https://github.com/paulmillr/chokidar#api
   */
  watch?: WatchOptions | null
  /**
   * Create Vite dev server to be used as a middleware in an existing server
   * @default false
   */
  middlewareMode?:
    | boolean
    | {
        /**
         * Parent server instance to attach to
         *
         * This is needed to proxy WebSocket connections to the parent server.
         */
        server: HttpServer
      }
  /**
   * Options for files served via '/\@fs/'.
   */
  fs?: FileSystemServeOptions
  /**
   * Origin for the generated asset URLs.
   *
   * @example `http://127.0.0.1:8080`
   */
  origin?: string
  /**
   * Pre-transform known direct imports
   * @default true
   */
  preTransformRequests?: boolean
  /**
   * Whether or not to ignore-list source files in the dev server sourcemap, used to populate
   * the [`x_google_ignoreList` source map extension](https://developer.chrome.com/blog/devtools-better-angular-debugging/#the-x_google_ignorelist-source-map-extension).
   *
   * By default, it excludes all paths containing `node_modules`. You can pass `false` to
   * disable this behavior, or, for full control, a function that takes the source path and
   * sourcemap path and returns whether to ignore the source path.
   */
  sourcemapIgnoreList?:
    | false
    | ((sourcePath: string, sourcemapPath: string) => boolean)
}

export interface ResolvedServerOptions
  extends Omit<ServerOptions, 'fs' | 'middlewareMode' | 'sourcemapIgnoreList'> {
  fs: Required<FileSystemServeOptions>
  middlewareMode: NonNullable<ServerOptions['middlewareMode']>
  sourcemapIgnoreList: Exclude<
    ServerOptions['sourcemapIgnoreList'],
    false | undefined
  >
}

export interface FileSystemServeOptions {
  /**
   * Strictly restrict file accessing outside of allowing paths.
   *
   * Set to `false` to disable the warning
   *
   * @default true
   */
  strict?: boolean

  /**
   * Restrict accessing files outside the allowed directories.
   *
   * Accepts absolute path or a path relative to project root.
   * Will try to search up for workspace root by default.
   */
  allow?: string[]

  /**
   * Restrict accessing files that matches the patterns.
   *
   * This will have higher priority than `allow`.
   * picomatch patterns are supported.
   *
   * @default ['.env', '.env.*', '*.crt', '*.pem']
   */
  deny?: string[]

  /**
   * Enable caching of fs calls. It is enabled by default if no custom watch ignored patterns are provided.
   *
   * @experimental
   * @default undefined
   */
  cachedChecks?: boolean
}

export type ServerHook = (
  this: void,
  server: ViteDevServer,
) => (() => void) | void | Promise<(() => void) | void>

export type HttpServer = http.Server | Http2SecureServer

export interface ViteDevServer {
  /**
   * The resolved vite config object
   */
  config: ResolvedConfig
  /**
   * A connect app instance.
   * - Can be used to attach custom middlewares to the dev server.
   * - Can also be used as the handler function of a custom http server
   *   or as a middleware in any connect-style Node.js frameworks
   *
   * https://github.com/senchalabs/connect#use-middleware
   */
  middlewares: Connect.Server
  /**
   * native Node http server instance
   * will be null in middleware mode
   */
  httpServer: HttpServer | null
  /**
   * chokidar watcher instance
   * https://github.com/paulmillr/chokidar#api
   */
  watcher: FSWatcher
  /**
   * web socket server with `send(payload)` method
   */
  ws: WebSocketServer
  /**
   * HMR broadcaster that can be used to send custom HMR messages to the client
   *
   * Always sends a message to at least a WebSocket client. Any third party can
   * add a channel to the broadcaster to process messages
   * @deprecated will be replaced with the environment api in v6.
   */
  hot: HMRBroadcaster
  /**
   * Rollup plugin container that can run plugin hooks on a given file
   */
  pluginContainer: PluginContainer
  /**
   * Module graph that tracks the import relationships, url to file mapping
   * and hmr state.
   */
  moduleGraph: ModuleGraph
  /**
   * The resolved urls Vite prints on the CLI. null in middleware mode or
   * before `server.listen` is called.
   */
  resolvedUrls: ResolvedServerUrls | null
  /**
   * Programmatically resolve, load and transform a URL and get the result
   * without going through the http request pipeline.
   */
  transformRequest(
    url: string,
    options?: TransformOptions,
  ): Promise<TransformResult | null>
  /**
   * Same as `transformRequest` but only warm up the URLs so the next request
   * will already be cached. The function will never throw as it handles and
   * reports errors internally.
   */
  warmupRequest(url: string, options?: TransformOptions): Promise<void>
  /**
   * Apply vite built-in HTML transforms and any plugin HTML transforms.
   */
  transformIndexHtml(
    url: string,
    html: string,
    originalUrl?: string,
  ): Promise<string>
  /**
   * Transform module code into SSR format.
   */
  ssrTransform(
    code: string,
    inMap: SourceMap | { mappings: '' } | null,
    url: string,
    originalCode?: string,
  ): Promise<TransformResult | null>
  /**
   * Load a given URL as an instantiated module for SSR.
   */
  ssrLoadModule(
    url: string,
    opts?: { fixStacktrace?: boolean },
  ): Promise<Record<string, any>>
  /**
   * Fetch information about the module for Vite SSR runtime.
   * @experimental
   */
  ssrFetchModule(id: string, importer?: string): Promise<FetchResult>
  /**
   * Returns a fixed version of the given stack
   */
  ssrRewriteStacktrace(stack: string): string
  /**
   * Mutates the given SSR error by rewriting the stacktrace
   */
  ssrFixStacktrace(e: Error): void
  /**
   * Triggers HMR for a module in the module graph. You can use the `server.moduleGraph`
   * API to retrieve the module to be reloaded. If `hmr` is false, this is a no-op.
   */
  reloadModule(module: ModuleNode): Promise<void>
  /**
   * Start the server.
   */
  listen(port?: number, isRestart?: boolean): Promise<ViteDevServer>
  /**
   * Stop the server.
   */
  close(): Promise<void>
  /**
   * Print server urls
   */
  printUrls(): void
  /**
   * Bind CLI shortcuts
   */
  bindCLIShortcuts(options?: BindCLIShortcutsOptions<ViteDevServer>): void
  /**
   * Restart the server.
   *
   * @param forceOptimize - force the optimizer to re-bundle, same as --force cli flag
   */
  restart(forceOptimize?: boolean): Promise<void>

  /**
   * Open browser
   */
  openBrowser(): void
  /**
   * Calling `await server.waitForRequestsIdle(id)` will wait until all static imports
   * are processed. If called from a load or transform plugin hook, the id needs to be
   * passed as a parameter to avoid deadlocks. Calling this function after the first
   * static imports section of the module graph has been processed will resolve immediately.
   * @experimental
   */
  waitForRequestsIdle: (ignoredId?: string) => Promise<void>
  /**
   * @internal
   */
  _registerRequestProcessing: (id: string, done: () => Promise<unknown>) => void
  /**
   * @internal
   */
  _onCrawlEnd(cb: () => void): void
  /**
   * @internal
   */
  _setInternalServer(server: ViteDevServer): void
  /**
   * @internal
   */
  _importGlobMap: Map<string, { affirmed: string[]; negated: string[] }[]>
  /**
   * @internal
   */
  _restartPromise: Promise<void> | null
  /**
   * @internal
   */
  _forceOptimizeOnRestart: boolean
  /**
   * @internal
   */
  _pendingRequests: Map<
    string,
    {
      request: Promise<TransformResult | null>
      timestamp: number
      abort: () => void
    }
  >
  /**
   * @internal
   */
  _fsDenyGlob: Matcher
  /**
   * @internal
   */
  _shortcutsOptions?: BindCLIShortcutsOptions<ViteDevServer>
  /**
   * @internal
   */
  _currentServerPort?: number | undefined
  /**
   * @internal
   */
  _configServerPort?: number | undefined
}

export interface ResolvedServerUrls {
  local: string[]
  network: string[]
}

export function createServer(
  inlineConfig: InlineConfig = {},
): Promise<ViteDevServer> {
  return _createServer(inlineConfig, { hotListen: true })
}

export async function _createServer(
  inlineConfig: InlineConfig = {},
  options: { hotListen: boolean },
): Promise<ViteDevServer> {
  // 处理配置文件
  //
  const config = await resolveConfig(inlineConfig, 'serve')

  // 读取 publck 文件并不立即执行等待结果
  const initPublicFilesPromise = initPublicFiles(config)
  // 根路径 ，服务器
  const { root, server: serverConfig } = config

  //解析 http 配置支持 http
  const httpsOptions = await resolveHttpsConfig(config.server.https) // undefined

  // 判断是否为中间件模式
  const { middlewareMode } = serverConfig // false

  // 构建输出路径dist
  const resolvedOutDirs = getResolvedOutDirs(
    config.root,
    config.build.outDir,
    config.build.rollupOptions?.output,
  ) // Set(1) { '/Users/lihaoran/ayu/vite/vite/packages/vite/dist' }

  // 配置是否清空输出目录
  const emptyOutDir = resolveEmptyOutDir(
    config.build.emptyOutDir,
    config.root,
    resolvedOutDirs,
  ) // true

  // chokidar 配置对象 过滤文件，一些其他配置
  const resolvedWatchOptions = resolveChokidarOptions(
    config,
    {
      disableGlobbing: true,
      ...serverConfig.watch,
    },
    resolvedOutDirs,
    emptyOutDir,
  )

  //创建中间件服务器
  const middlewares = connect() as Connect.Server

  // serverConfig 服务器配置
  // httpsOptions https 配置
  // 创建 http/https 服务器
  // http服务器
  const httpServer = middlewareMode
    ? null
    : await resolveHttpServer(serverConfig, middlewares, httpsOptions)
  // console.log(httpServer, 'httpServer=>(index.ts:485)')

  // console.log(serverConfig, 'serverConfig=>(index.ts:483)')

  // 创建 websocket 对象（包含基础方法)
  const ws = createWebSocketServer(httpServer, config, httpsOptions)
  // 创建一个HMR消息广播系统, 支持两种通信方式：
  //WebSocket通道(ws)：负责向浏览器发送HMR更新消息，实现页面热更新
  // 服务器通道(createServerHMRChannel())：负责通知服务器端插件和中间件的更新
  const hot = createHMRBroadcaster()
    .addChannel(ws)
    .addChannel(createServerHMRChannel())

  if (typeof config.server.hmr === 'object' && config.server.hmr.channels) {
    config.server.hmr.channels.forEach((channel) => hot.addChannel(channel))
  }

  // 获取public 文件
  const publicFiles = await initPublicFilesPromise //Set(1) { '/1.js' }
  const { publicDir } = config

  if (httpServer) {
    // 处理客户端错误的核心函数
    setClientErrorHandler(httpServer, config.logger)
  }

  /// serverConfig.watch undefined
  // eslint-disable-next-line eqeqeq
  const watchEnabled = serverConfig.watch !== null // true
  // 设置监视文件的函数配置
  const watcher = watchEnabled
    ? (chokidar.watch(
        // config file dependencies and env file might be outside of root
        [
          root,
          ...config.configFileDependencies,
          ...getEnvFilesForMode(config.mode, config.envDir),
          // Watch the public directory explicitly because it might be outside
          // of the root directory.
          ...(publicDir && publicFiles ? [publicDir] : []),
        ],
        resolvedWatchOptions,
      ) as FSWatcher)
    : createNoopWatcher(resolvedWatchOptions)

  // Vite 进行模块依赖分析和热更新的基础设施
  const moduleGraph: ModuleGraph = new ModuleGraph((url, ssr) =>
    container.resolveId(url, undefined, { ssr }),
  )

  // 创建插件容器，管理所有 Vite 插件,负责协调插件的执行顺序和生命周期，
  const container = await createPluginContainer(config, moduleGraph, watcher)

  // 关闭 http 服务器的函数
  const closeHttpServer = createServerCloseFn(httpServer)

  //创建开发环境下的 HTML 转换函数
  const devHtmlTransformFn = createDevHtmlTransformFn(config)

  const onCrawlEndCallbacks: (() => void)[] = []
  const crawlEndFinder = setupOnCrawlEnd(() => {
    onCrawlEndCallbacks.forEach((cb) => cb())
  })
  function waitForRequestsIdle(ignoredId?: string): Promise<void> {
    return crawlEndFinder.waitForRequestsIdle(ignoredId)
  }
  function _registerRequestProcessing(id: string, done: () => Promise<any>) {
    crawlEndFinder.registerRequestProcessing(id, done)
  }
  function _onCrawlEnd(cb: () => void) {
    onCrawlEndCallbacks.push(cb)
  }

  let server: ViteDevServer = {
    config, // vite 配置对象
    middlewares, // 中间件集合
    httpServer, // http 服务器实例
    watcher, // 文件监听器
    pluginContainer: container, // 插件容器
    ws, // websocket服务器
    hot, // HMR 管理器
    moduleGraph, //模块依赖图
    resolvedUrls: null, // will be set on listen
    // ssr 代码转换
    ssrTransform(
      code: string,
      inMap: SourceMap | { mappings: '' } | null,
      url: string,
      originalCode = code,
    ) {
      return ssrTransform(code, inMap, url, originalCode, server.config)
    },
    // 请求转换
    transformRequest(url, options) {
      return transformRequest(url, server, options)
    },
    // 预热请求 - 优化首次加载性能
    async warmupRequest(url, options) {
      try {
        await transformRequest(url, server, options)
      } catch (e) {
        if (
          e?.code === ERR_OUTDATED_OPTIMIZED_DEP ||
          e?.code === ERR_CLOSED_SERVER
        ) {
          // these are expected errors
          return
        }
        // Unexpected error, log the issue but avoid an unhandled exception
        server.config.logger.error(`Pre-transform error: ${e.message}`, {
          error: e,
          timestamp: true,
        })
      }
    }, // html 转换
    transformIndexHtml(url, html, originalUrl) {
      return devHtmlTransformFn(server, url, html, originalUrl)
    },
    async ssrLoadModule(url, opts?: { fixStacktrace?: boolean }) {
      return ssrLoadModule(url, server, undefined, opts?.fixStacktrace)
    },
    async ssrFetchModule(url: string, importer?: string) {
      return ssrFetchModule(server, url, importer)
    },
    ssrFixStacktrace(e) {
      ssrFixStacktrace(e, moduleGraph)
    },
    ssrRewriteStacktrace(stack: string) {
      return ssrRewriteStacktrace(stack, moduleGraph)
    },
    // TODO 模块更新逻辑 !!!!
    async reloadModule(module) {
      if (serverConfig.hmr !== false && module.file) {
        updateModules(module.file, [module], Date.now(), server)
      }
    },
    // 启动服务器
    async listen(port?: number, isRestart?: boolean) {
      // 开启服务器
      await startServer(server, port) //给服务器设置端口

      if (httpServer) {
        server.resolvedUrls = await resolveServerUrls(
          httpServer,
          config.server,
          config,
        ) // { local: [ 'http://localhost:5173/' ], network: [] }
        if (!isRestart && config.server.open) server.openBrowser()
      }
      return server
    },
    openBrowser() {
      const options = server.config.server
      const url =
        server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0]
      if (url) {
        const path =
          typeof options.open === 'string'
            ? new URL(options.open, url).href
            : url

        // We know the url that the browser would be opened to, so we can
        // start the request while we are awaiting the browser. This will
        // start the crawling of static imports ~500ms before.
        // preTransformRequests needs to be enabled for this optimization.
        if (server.config.server.preTransformRequests) {
          setTimeout(() => {
            const getMethod = path.startsWith('https:') ? httpsGet : httpGet

            getMethod(
              path,
              {
                headers: {
                  // Allow the history middleware to redirect to /index.html
                  Accept: 'text/html',
                },
              },
              (res) => {
                res.on('end', () => {
                  // Ignore response, scripts discovered while processing the entry
                  // will be preprocessed (server.config.server.preTransformRequests)
                })
              },
            )
              .on('error', () => {
                // Ignore errors
              })
              .end()
          }, 0)
        }

        _openBrowser(path, true, server.config.logger)
      } else {
        server.config.logger.warn('No URL available to open in browser')
      }
    },
    // 关闭服务器
    async close() {
      if (!middlewareMode) {
        teardownSIGTERMListener(closeServerAndExit)
      }
      await Promise.allSettled([
        watcher.close(),
        hot.close(),
        container.close(),
        crawlEndFinder?.cancel(),
        getDepsOptimizer(server.config)?.close(),
        getDepsOptimizer(server.config, true)?.close(),
        closeHttpServer(),
      ])
      // Await pending requests. We throw early in transformRequest
      // and in hooks if the server is closing for non-ssr requests,
      // so the import analysis plugin stops pre-transforming static
      // imports and this block is resolved sooner.
      // During SSR, we let pending requests finish to avoid exposing
      // the server closed error to the users.
      while (server._pendingRequests.size > 0) {
        await Promise.allSettled(
          [...server._pendingRequests.values()].map(
            (pending) => pending.request,
          ),
        )
      }
      server.resolvedUrls = null
    },
    // 打印服务器 url
    printUrls() {
      if (server.resolvedUrls) {
        printServerUrls(
          server.resolvedUrls,
          serverConfig.host,
          config.logger.info,
        )
      } else if (middlewareMode) {
        throw new Error('cannot print server URLs in middleware mode.')
      } else {
        throw new Error(
          'cannot print server URLs before server.listen is called.',
        )
      }
    },
    bindCLIShortcuts(options) {
      bindCLIShortcuts(server, options)
    },
    async restart(forceOptimize?: boolean) {
      if (!server._restartPromise) {
        server._forceOptimizeOnRestart = !!forceOptimize
        server._restartPromise = restartServer(server).finally(() => {
          server._restartPromise = null
          server._forceOptimizeOnRestart = false
        })
      }
      return server._restartPromise
    },

    waitForRequestsIdle,
    _registerRequestProcessing,
    _onCrawlEnd,

    _setInternalServer(_server: ViteDevServer) {
      // Rebind internal the server variable so functions reference the user
      // server instance after a restart
      server = _server
    },
    _restartPromise: null,
    _importGlobMap: new Map(),
    _forceOptimizeOnRestart: false,
    _pendingRequests: new Map(),
    _fsDenyGlob: picomatch(
      // matchBase: true does not work as it's documented
      // https://github.com/micromatch/picomatch/issues/89
      // convert patterns without `/` on our side for now
      config.server.fs.deny.map((pattern) =>
        pattern.includes('/') ? pattern : `**/${pattern}`,
      ),
      {
        matchBase: false,
        nocase: true,
        dot: true,
      },
    ),
    _shortcutsOptions: undefined,
  }

  // maintain consistency with the server instance after restarting.
  const reflexServer = new Proxy(server, {
    get: (_, property: keyof ViteDevServer) => {
      return server[property]
    },
    set: (_, property: keyof ViteDevServer, value: never) => {
      server[property] = value
      return true
    },
  })

  const closeServerAndExit = async () => {
    try {
      await server.close()
    } finally {
      process.exit()
    }
  }

  if (!middlewareMode) {
    setupSIGTERMListener(closeServerAndExit)
  }

  const onHMRUpdate = async (
    type: 'create' | 'delete' | 'update',
    file: string,
  ) => {
    if (serverConfig.hmr !== false) {
      try {
        await handleHMRUpdate(type, file, server)
      } catch (err) {
        hot.send({
          type: 'error',
          err: prepareError(err),
        })
      }
    }
  }

  const onFileAddUnlink = async (file: string, isUnlink: boolean) => {
    file = normalizePath(file)
    await container.watchChange(file, { event: isUnlink ? 'delete' : 'create' })

    if (publicDir && publicFiles) {
      if (file.startsWith(publicDir)) {
        const path = file.slice(publicDir.length)
        publicFiles[isUnlink ? 'delete' : 'add'](path)
        if (!isUnlink) {
          const moduleWithSamePath = await moduleGraph.getModuleByUrl(path)
          const etag = moduleWithSamePath?.transformResult?.etag
          if (etag) {
            // The public file should win on the next request over a module with the
            // same path. Prevent the transform etag fast path from serving the module
            moduleGraph.etagToModuleMap.delete(etag)
          }
        }
      }
    }
    if (isUnlink) moduleGraph.onFileDelete(file)
    await onHMRUpdate(isUnlink ? 'delete' : 'create', file)
  }

  // 监听文件变化
  watcher.on('change', async (file) => {
    file = normalizePath(file) //规范化路径
    await container.watchChange(file, { event: 'update' })
    // invalidate module graph cache on file change
    moduleGraph.onFileChange(file)
    await onHMRUpdate('update', file) // 处理热更新
  })

  getFsUtils(config).initWatcher?.(watcher)

  watcher.on('add', (file) => {
    onFileAddUnlink(file, false)
  })
  watcher.on('unlink', (file) => {
    onFileAddUnlink(file, true)
  })

  hot.on('vite:invalidate', async ({ path, message }) => {
    const mod = moduleGraph.urlToModuleMap.get(path)
    if (
      mod &&
      mod.isSelfAccepting &&
      mod.lastHMRTimestamp > 0 &&
      !mod.lastHMRInvalidationReceived
    ) {
      mod.lastHMRInvalidationReceived = true
      config.logger.info(
        colors.yellow(`hmr invalidate `) +
          colors.dim(path) +
          (message ? ` ${message}` : ''),
        { timestamp: true },
      )
      const file = getShortName(mod.file!, config.root)
      updateModules(
        file,
        [...mod.importers],
        mod.lastHMRTimestamp,
        server,
        true,
      )
    }
  })

  if (!middlewareMode && httpServer) {
    httpServer.once('listening', () => {
      // update actual port since this may be different from initial value
      serverConfig.port = (httpServer.address() as net.AddressInfo).port
    })
  }

  // apply server configuration hooks from plugins
  const postHooks: ((() => void) | void)[] = []
  for (const hook of config.getSortedPluginHooks('configureServer')) {
    postHooks.push(await hook(reflexServer))
  }

  // Internal middlewares ------------------------------------------------------

  // request timer
  if (process.env.DEBUG) {
    middlewares.use(timeMiddleware(root))
  }

  // cors (enabled by default)
  const { cors } = serverConfig
  if (cors !== false) {
    middlewares.use(corsMiddleware(typeof cors === 'boolean' ? {} : cors))
  }

  middlewares.use(cachedTransformMiddleware(server))

  // proxy
  const { proxy } = serverConfig
  if (proxy) {
    const middlewareServer =
      (isObject(middlewareMode) ? middlewareMode.server : null) || httpServer
    middlewares.use(proxyMiddleware(middlewareServer, proxy, config))
  }

  // base
  if (config.base !== '/') {
    middlewares.use(baseMiddleware(config.rawBase, !!middlewareMode))
  }

  // open in editor support
  middlewares.use('/__open-in-editor', launchEditorMiddleware())

  // ping request handler
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  middlewares.use(function viteHMRPingMiddleware(req, res, next) {
    if (req.headers['accept'] === 'text/x-vite-ping') {
      res.writeHead(204).end()
    } else {
      next()
    }
  })

  // serve static files under /public
  // this applies before the transform middleware so that these files are served
  // as-is without transforms.
  if (publicDir) {
    middlewares.use(servePublicMiddleware(server, publicFiles))
  }

  // main transform middleware
  middlewares.use(transformMiddleware(server))

  // serve static files
  middlewares.use(serveRawFsMiddleware(server))
  middlewares.use(serveStaticMiddleware(server))

  // html fallback
  if (config.appType === 'spa' || config.appType === 'mpa') {
    middlewares.use(
      htmlFallbackMiddleware(
        root,
        config.appType === 'spa',
        getFsUtils(config),
      ),
    )
  }

  // run post config hooks
  // This is applied before the html middleware so that user middleware can
  // serve custom content instead of index.html.
  postHooks.forEach((fn) => fn && fn())

  if (config.appType === 'spa' || config.appType === 'mpa') {
    // transform index.html
    middlewares.use(indexHtmlMiddleware(root, server))

    // handle 404s
    middlewares.use(notFoundMiddleware())
  }

  // error handler
  middlewares.use(errorMiddleware(server, !!middlewareMode))

  // httpServer.listen can be called multiple times
  // when port when using next port number
  // this code is to avoid calling buildStart multiple times
  let initingServer: Promise<void> | undefined
  let serverInited = false
  const initServer = async () => {
    if (serverInited) return
    if (initingServer) return initingServer

    initingServer = (async function () {
      await container.buildStart({})
      // start deps optimizer after all container plugins are ready
      if (isDepsOptimizerEnabled(config, false)) {
        await initDepsOptimizer(config, server)
      }
      warmupFiles(server)
      initingServer = undefined
      serverInited = true
    })()
    return initingServer
  }

  if (!middlewareMode && httpServer) {
    // overwrite listen to init optimizer before server start
    const listen = httpServer.listen.bind(httpServer)
    httpServer.listen = (async (port: number, ...args: any[]) => {
      try {
        // ensure ws server started
        hot.listen()
        await initServer()
      } catch (e) {
        httpServer.emit('error', e)
        return
      }
      return listen(port, ...args)
    }) as any
  } else {
    if (options.hotListen) {
      hot.listen()
    }
    await initServer()
  }

  return server
}

async function startServer(
  server: ViteDevServer,
  inlinePort?: number,
): Promise<void> {
  const httpServer = server.httpServer //http服务器

  if (!httpServer) {
    throw new Error('Cannot call server.listen in middleware mode.')
  }

  const options = server.config.server // config.server配置
  const hostname = await resolveHostname(options.host) // { host: 'localhost', name: 'localhost' }
  const configPort = inlinePort ?? options.port // undefined
  // When using non strict port for the dev server, the running port can be different from the config one.
  // When restarting, the original port may be available but to avoid a switch of URL for the running
  // browser tabs, we enforce the previously used port, expect if the config port changed.
  const port =
    (!configPort || configPort === server._configServerPort
      ? server._currentServerPort
      : configPort) ?? DEFAULT_DEV_PORT // 5173

  server._configServerPort = configPort

  const obj = {
    port,
    strictPort: options.strictPort,
    host: hostname.host,
    logger: server.config.logger,
  }

  // 当前端口号
  server._currentServerPort = await httpServerStart(httpServer, obj)
}

export function createServerCloseFn(
  server: HttpServer | null,
): () => Promise<void> {
  if (!server) {
    return () => Promise.resolve()
  }

  let hasListened = false
  const openSockets = new Set<net.Socket>()

  server.on('connection', (socket) => {
    openSockets.add(socket)
    socket.on('close', () => {
      openSockets.delete(socket)
    })
  })

  server.once('listening', () => {
    hasListened = true
  })

  return () =>
    new Promise<void>((resolve, reject) => {
      openSockets.forEach((s) => s.destroy())
      if (hasListened) {
        server.close((err) => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      } else {
        resolve()
      }
    })
}

function resolvedAllowDir(root: string, dir: string): string {
  return normalizePath(path.resolve(root, dir))
}

export function resolveServerOptions(
  root: string,
  raw: ServerOptions | undefined,
  logger: Logger,
): ResolvedServerOptions {
  const server: ResolvedServerOptions = {
    preTransformRequests: true,
    ...(raw as Omit<ResolvedServerOptions, 'sourcemapIgnoreList'>),
    sourcemapIgnoreList:
      raw?.sourcemapIgnoreList === false
        ? () => false
        : raw?.sourcemapIgnoreList || isInNodeModules,
    middlewareMode: raw?.middlewareMode || false,
  }
  let allowDirs = server.fs?.allow
  const deny = server.fs?.deny || ['.env', '.env.*', '*.{crt,pem}']

  if (!allowDirs) {
    allowDirs = [searchForWorkspaceRoot(root)]
  }

  if (process.versions.pnp) {
    try {
      const enableGlobalCache =
        execSync('yarn config get enableGlobalCache', { cwd: root })
          .toString()
          .trim() === 'true'
      const yarnCacheDir = execSync(
        `yarn config get ${enableGlobalCache ? 'globalFolder' : 'cacheFolder'}`,
        { cwd: root },
      )
        .toString()
        .trim()
      allowDirs.push(yarnCacheDir)
    } catch (e) {
      logger.warn(`Get yarn cache dir error: ${e.message}`, {
        timestamp: true,
      })
    }
  }

  allowDirs = allowDirs.map((i) => resolvedAllowDir(root, i))

  // only push client dir when vite itself is outside-of-root
  const resolvedClientDir = resolvedAllowDir(root, CLIENT_DIR)
  if (!allowDirs.some((dir) => isParentDirectory(dir, resolvedClientDir))) {
    allowDirs.push(resolvedClientDir)
  }

  server.fs = {
    strict: server.fs?.strict ?? true,
    allow: allowDirs,
    deny,
    cachedChecks: server.fs?.cachedChecks,
  }

  if (server.origin?.endsWith('/')) {
    server.origin = server.origin.slice(0, -1)
    logger.warn(
      colors.yellow(
        `${colors.bold('(!)')} server.origin should not end with "/". Using "${
          server.origin
        }" instead.`,
      ),
    )
  }

  return server
}

async function restartServer(server: ViteDevServer) {
  global.__vite_start_time = performance.now()
  const shortcutsOptions = server._shortcutsOptions

  let inlineConfig = server.config.inlineConfig
  if (server._forceOptimizeOnRestart) {
    inlineConfig = mergeConfig(inlineConfig, {
      optimizeDeps: {
        force: true,
      },
    })
  }

  // Reinit the server by creating a new instance using the same inlineConfig
  // This will trigger a reload of the config file and re-create the plugins and
  // middlewares. We then assign all properties of the new server to the existing
  // server instance and set the user instance to be used in the new server.
  // This allows us to keep the same server instance for the user.
  {
    let newServer = null
    try {
      // delay ws server listen
      newServer = await _createServer(inlineConfig, { hotListen: false })
    } catch (err: any) {
      server.config.logger.error(err.message, {
        timestamp: true,
      })
      server.config.logger.error('server restart failed', { timestamp: true })
      return
    }

    await server.close()

    // Assign new server props to existing server instance
    const middlewares = server.middlewares
    newServer._configServerPort = server._configServerPort
    newServer._currentServerPort = server._currentServerPort
    Object.assign(server, newServer)

    // Keep the same connect instance so app.use(vite.middlewares) works
    // after a restart in middlewareMode (.route is always '/')
    middlewares.stack = newServer.middlewares.stack
    server.middlewares = middlewares

    // Rebind internal server variable so functions reference the user server
    newServer._setInternalServer(server)
  }

  const {
    logger,
    server: { port, middlewareMode },
  } = server.config
  if (!middlewareMode) {
    await server.listen(port, true)
  } else {
    server.hot.listen()
  }
  logger.info('server restarted.', { timestamp: true })

  if (shortcutsOptions) {
    shortcutsOptions.print = false
    bindCLIShortcuts(server, shortcutsOptions)
  }
}

/**
 * Internal function to restart the Vite server and print URLs if changed
 */
export async function restartServerWithUrls(
  server: ViteDevServer,
): Promise<void> {
  if (server.config.server.middlewareMode) {
    await server.restart()
    return
  }

  const { port: prevPort, host: prevHost } = server.config.server
  const prevUrls = server.resolvedUrls

  await server.restart()

  const {
    logger,
    server: { port, host },
  } = server.config
  if (
    (port ?? DEFAULT_DEV_PORT) !== (prevPort ?? DEFAULT_DEV_PORT) ||
    host !== prevHost ||
    diffDnsOrderChange(prevUrls, server.resolvedUrls)
  ) {
    logger.info('')
    server.printUrls()
  }
}

const callCrawlEndIfIdleAfterMs = 50

interface CrawlEndFinder {
  registerRequestProcessing: (id: string, done: () => Promise<any>) => void
  waitForRequestsIdle: (ignoredId?: string) => Promise<void>
  cancel: () => void
}

function setupOnCrawlEnd(onCrawlEnd: () => void): CrawlEndFinder {
  const registeredIds = new Set<string>()
  const seenIds = new Set<string>()
  const onCrawlEndPromiseWithResolvers = promiseWithResolvers<void>()

  let timeoutHandle: NodeJS.Timeout | undefined

  let cancelled = false
  function cancel() {
    cancelled = true
  }

  let crawlEndCalled = false
  function callOnCrawlEnd() {
    if (!cancelled && !crawlEndCalled) {
      crawlEndCalled = true
      onCrawlEnd()
    }
    onCrawlEndPromiseWithResolvers.resolve()
  }

  function registerRequestProcessing(
    id: string,
    done: () => Promise<any>,
  ): void {
    if (!seenIds.has(id)) {
      seenIds.add(id)
      registeredIds.add(id)
      done()
        .catch(() => {})
        .finally(() => markIdAsDone(id))
    }
  }

  function waitForRequestsIdle(ignoredId?: string): Promise<void> {
    if (ignoredId) {
      seenIds.add(ignoredId)
      markIdAsDone(ignoredId)
    }
    return onCrawlEndPromiseWithResolvers.promise
  }

  function markIdAsDone(id: string): void {
    if (registeredIds.has(id)) {
      registeredIds.delete(id)
      checkIfCrawlEndAfterTimeout()
    }
  }

  function checkIfCrawlEndAfterTimeout() {
    if (cancelled || registeredIds.size > 0) return

    if (timeoutHandle) clearTimeout(timeoutHandle)
    timeoutHandle = setTimeout(
      callOnCrawlEndWhenIdle,
      callCrawlEndIfIdleAfterMs,
    )
  }
  async function callOnCrawlEndWhenIdle() {
    if (cancelled || registeredIds.size > 0) return
    callOnCrawlEnd()
  }

  return {
    registerRequestProcessing,
    waitForRequestsIdle,
    cancel,
  }
}
