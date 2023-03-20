# rebuild-aio

> A watcher with a customizable transpilation.

## Usage

```
Usage:
    rebuild --watch <glob> [--transform <glob>] [--using <file.js>] --output <dir> --exec <string>
    
Example:
    rebuild --watch src --transform 'src/*/src/**/*.{js,mjs}' --using transformer.js --output build --exec 'echo "server started"'
 
Options:
    --watch -w        A glob. All watched files go to the output, but some are transformed along the way. At least one required.
    --transform -t    Files matching this glob are passed through the transformer. Optional.
    --using -u        The transformer. A JS file which has at least `default export (inputPath, outputPath, contents) => {return contents}`. Optional.
    --output -o       The output directory. Required.
    --exec -e         The command to exec after rebuild. Optional. If omitted, then rebuild will exit after the first build. This is useful for packaging before deploying.
    --kill -k         A port to kill on ctrl+c. Optional. Multiple allowed.
    --debug -d        Log statements about node_modules are excluded by default.
```
