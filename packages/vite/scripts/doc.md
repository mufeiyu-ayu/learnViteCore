这段代码是 Vite 项目的构建和开发脚本。让我逐步解释一下它的作用:

清理和创建输出目录

首先使用 rmSync 删除 dist 目录,这是 Vite 的输出目录。
然后使用 mkdirSync 创建 dist/node 目录,用于存放构建后的文件。
接下来生成两个 TypeScript 声明文件 dist/node/index.d.ts 和 dist/node/runtime.d.ts，用于提供类型支持。

配置 esbuild 构建选项

定义两个构建选项对象 serverOptions 和 clientOptions。
serverOptions 用于构建 Node.js 端的代码,clientOptions 用于构建浏览器端的代码。
这里设置了一些常见的构建选项,如打包、目标平台、目标 ES 版本、sourcemap 生成等。
还配置了 external 选项,排除了一些依赖项不需要打包。

定义监听构建的函数

创建了一个 watch 函数,用于启动 esbuild 的监听构建模式。
该函数接收构建选项作为参数,并使用 context 和 watch 方法启动监听。

执行实际的构建任务

调用 watch 函数执行 4 个构建任务:

envConfig: 构建 src/client/env.ts 文件,输出到 dist/client/env.mjs。
clientConfig: 构建 src/client/client.ts 文件,输出到 dist/client/client.mjs。
nodeConfig: 构建 src/node 目录下的多个入口文件,输出到 dist/node 目录。这里还添加了一个自定义插件,用于修复 esbuild 在处理 require 调用时的一个 bug。
runtimeConfig: 构建 src/runtime/index.ts 文件,输出到 dist/node/runtime.js。
cjsConfig: 构建 src/node/publicUtils.ts 文件,输出到 dist/node-cjs/publicUtils.cjs 作为 CommonJS 模块。
