# rebuild-aio

> Watch, rebuild, bundle, all-in-one

## Usage

```
Usage:
    rebuild \ 
    --watch <glob> \ 
    [--transform <glob>] \ 
    [--using <file.js>] \
    --output <dir> \
    [--fork <string>] \
    [--spawn <string>] \ 
    [--kill <number>] \
    [--wait <number>] 
    
Example:
    rebuild --watch src --transform 'src/*/src/**/*.{js,mjs}' --transform 'src/web/node_modules/**/*.{js,mjs}' --using transformer.js --output build --fork server.js -k 3000 --wait 500

Options:
    --watch -w        A glob. All watched files go to the output, but some are transformed along the way. At least one required.
    --transform -t    Files matching this glob are passed through the transformer. Multiple allowed.
    --using -u        The transformer. A JS file. Default: `default export async (inputPath, outputPath, contents) => {return contents}`. Optional.
    --output -o       The output directory. Required.
    --fork -f         The restart command. Optional. If omitted, then rebuild will exit after the first build.
    --spawn -s        The restart command. Optional. If omitted, no rebuilding or monitoring happens.
    --cleanup -c      A JS file. Signature: `default export async (child, spawnerType, signal) => {}`. Optional.
    --kill -k         A port to kill on ctrl+c. Optional. Multiple allowed.
    --wait            How long to wait on file changes and termination before forcefully stopping the process. Default is 3000.
    --debug -d        Log statements about node_modules are excluded by default.
```

## Overview

1. Visit all files in watch tree.
2. For each file, if it matches the `--transform` glob, then pass it through the transformer specified using `--using`.
3. Pass the transformed (or original if no transform was performed) file to the `--output` dir.
4. If `--fork` or `--spawn` are defined, run the command. Changes are watched, passed through the transform again, and the exec command re-executed.
   1. While running as a change watcher, ctrl+c interrupt will cause the ports listed by `--kill` to be killed. Port killing does not happen on change restarts.
   2. While running as a change watcher, the optional function passed by `--cleanup` is awaited. This provides a way to implement custom restart logic. For example, you might want to utilize the fork's IPC connection to send a message using `childProcess.send()`, allowing the server to gracefully handle restarts.
5. If `--fork` or `--spawn` are not defined, then stop after the initial build instead of watching and rebuilding.

## --transform --using

This package supports a customizable transform step during the build process. Here is an example transformer:

```js
// transformer.js
import flowRemoveTypes from "flow-remove-types"
import convertJsx from "jsx-to-hyperscript"
import {transformImports} from "web-imports"
import fs from "fs"
import path from "path"

const clientPath = path.resolve('src/web')

function isUnder(filepath, dir) {
  return filepath.startsWith(dir)
}

// filepath and outputPath are absolute paths.
export default async function transform(filepath, outputPath, contents) {
  const filename = path.relative(path.resolve(outputPath, "../"), outputPath)

  // Remove type annotations, and possibly generate sourcemaps:
  const flowOut = flowRemoveTypes(contents)
  const flowConverted = flowOut.toString()
  const flowMap = flowOut.generateMap()
  fs.writeFileSync(
    path.resolve(outputPath, "../", `${filename}.map`),
    JSON.stringify(flowMap),
    { encoding: "utf-8" },
  )

  // Transform JSX:
  const jsxConverted = convertJsx(flowConverted)

  // Transform import statements in client:
  if (isUnder(filepath, clientPath)) {
    const importsConverted = await transformImports(jsxConverted, filepath)
    return importsConverted
  } else {
    return jsxConverted
  }
}
```

## --fork or --spawn

`--fork` causes the child process to be created using `fork`. This is useful for implementing graceful restarts.

The argument passed to `--fork` must be an ES module, I.E. a JS file. It cannot run CLI commands directly.

`--spawn` causes the child process to be created using `spawn`, but restarts terminate the process abruptly.

## SIGTERM

When using `--spawn`, restarts use `child.kill()`, which sends SIGTERM in non-Windows environments. In all environments, using `child.kill()`, the child process is ended abruptly, and on Linux, any of their subprocesses will not be terminated.

Because of these issues, it is recommended to use `--fork` and to implement a `SIGRES` handler in your code.

## SIGRES

SIGRES is sent during a restart. It is used for implementing graceful restarting.

A handler for it should be placed at the beginning of the script forked by `--fork`.

```js
// forked_process.js
process.on('message', (m) => {
  if (m === 'SIGRES') {
    process.exit() // must exit eventually.
  }
})
```

Note that SIGRES is made up, and it not a POSIX signal.

## SIGINT

The built-in POSIX signal SIGINT can be handled like this:

```js
process.on('SIGINT', () => {
  process.exit() // must exit eventually.
})
```

## --kill

`--kill` is used to kill processes behind ports on ctrl+c, but not on restarts.

If you need to kill ports on restarts, use a custom `--cleanup` function.

## --cleanup

Similar to `--transform`, this is a JS file which has a `default export`.

Cleanup is called on ctrl+c interrupts and restarts.

The `cleanup(child, spawnerType, signal)` function takes in the `child` which is a child process obtained from spawn or fork, and a `signal` whose value is either `SIGINT` or `SIGRES`. 

The function should either send a kill signal to the child and wait for it to exit itself, or abruptly kill the process using `child.kill()`.

You can send a kill signal to the child, with cross-platform support, using `--fork` and `child.send('SIGRES')`. This will cause the `child` to be a forked process, which allows messages between the parent and child to be passed using IPC.

This is the default cleanup function:

```js
// cleanup.js
// import {kill} from "cross-port-killer"

async (child, spawnerType, signal) => {
   if (signal === 'SIGINT') {
      child.kill('SIGINT') // child is expected to exit on its own
   } else {
      // SIGRES signal handling:
      if (spawnerType === 'spawn') {
         // await kill(4000)
         child.kill()
      } else if (spawnerType === 'fork') {
         child.send('SIGRES') // child is expected to exit on its own
      }
   }
}
```
