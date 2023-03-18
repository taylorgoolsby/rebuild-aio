# monitor-transpile

> A watcher with a customizable transpilation.

## Usage

```
Usage:
    monitor --watch <glob> [--transform <glob>] [--using <file.js>] --output <dir> --exec <string>
    
Example:
    monitor --watch src --transform 'src/*/src/**/*.{js,mjs}' --using transformer.js --output build --exec 'echo "server started"'
 
Options:
    --watch -w        A glob. All watched files go to the output, but some are transformed along the way. At least one required.
    --transform -t    Files matching this glob are passed through the transformer. Optional.
    --using -u        The transformer. A JS file which has at least `default export (fpath, contents) => {return contents}`. Optional.
    --output -o       The output directory. Required.
    --exec -e         The command to exec after rebuild. Required.
    --debug -d        Log statements about node_modules are excluded by default.
```
