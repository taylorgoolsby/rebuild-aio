# rebuild-aio

> A watcher with a customizable transpilation.

## Usage

```
Usage:
    rebuild \ 
    --watch <glob> \ 
    [--transform <glob>] \ 
    [--using <file.js>] \
    --output <dir> \
    [--exec <string>] \ 
    [--kill <number>] \
    
Example:
    rebuild \
    --watch src \ 
    --transform 'src/*/src/**/*.{js,mjs}' \ 
    --using transformer.js \
    --output build \
    --exec 'echo "server started"'
 
Options:
    --watch -w        A glob. All watched files go to the output, but some are transformed along the way. At least one required.
    --transform -t    Files matching this glob are passed through the transformer. Optional.
    --using -u        The transformer. A JS file which has at least `default export (inputPath, outputPath, contents) => {return contents}`. Optional.
    --output -o       The output directory. Required.
    --exec -e         The command to exec after rebuild. Optional. If omitted, then rebuild will exit after the first build. This is useful for packaging before deploying.
    --kill -k         A port to kill on ctrl+c. Optional. Multiple allowed.
    --debug -d        Log statements about node_modules are excluded by default.
```

## Overview

1. Visit all files in watch tree.
2. For each file, if it matches the `--transform` glob, then pass it through the transformer specified using `--using`.
3. Pass the transformed (or original if no transform was performed) file to the `--output` dir.
4. If `--exec` is defined, run the command. Changes are watched, passed through the transform again, and the exec command re-executed.
   1. While running as a change watcher, ctrl+c interrupt will cause the ports listed by `--kill` to be killed.
5. If `--exec` is not defined, then stop after the initial build instead of watching and rebuilding.

## Transform

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
