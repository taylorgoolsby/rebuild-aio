#!/usr/bin/env node

import minimist from 'minimist'
import watch from 'watch'
import c from 'ansi-colors'
import {fork, spawn} from 'child_process'
import fs from 'fs-extra'
import path from 'path'
import micromatch from 'micromatch'
import {kill} from "cross-port-killer";

const argv = minimist(process.argv.slice(2))
const help = argv['h'] || argv['help'] || Object.keys(argv).length === 1

if (help) {
  console.log(`${c.yellow('Usage:')}
    rebuild \\ 
    --watch <glob> \\ 
    [--transform <glob>] \\ 
    [--using <file.js>] \\
    --output <dir> \\
    [--fork <string>] \\
    [--spawn <string>] \\ 
    [--kill <number>] \\
    [--wait <number>] 
    
${c.yellow('Example:')}
    rebuild --watch src --transform 'src/*/src/**/*.{js,mjs}' --using transformer.js --output build --fork server.js -k 3000 --wait 500

${c.yellow('Options:')}
    --watch -w        ${c.grey('A glob. All watched files go to the output, but some are transformed along the way. At least one required.')}
    --transform -t    ${c.grey('Files matching this glob are passed through the transformer. Optional.')}
    --using -u        ${c.grey('The transformer. A JS file. Default: `default export async (inputPath, outputPath, contents) => {return contents}`. Optional.')}
    --output -o       ${c.grey('The output directory. Required.')}
    --fork -f         ${c.grey('The restart command. Optional. If omitted, then rebuild will exit after the first build.')}
    --spawn -s        ${c.grey('The restart command. Optional. If omitted, no rebuilding or monitoring happens.')}
    --cleanup -c      ${c.grey('A JS file. Signature: `default export async (child, spawnerType, signal) => {}`. Optional.')}
    --kill -k         ${c.grey('A port to kill on ctrl+c. Optional. Multiple allowed.')}
    --wait            ${c.grey('How long to wait on file changes and termination before forcefully stopping the process. Default is 3000.')}
    --debug -d        ${c.grey('Log statements about node_modules are excluded by default.')}`)
} else {
  const w = argv['w'] || argv['watch']
  const watchDirs = Array.isArray(w) ? w : [w].filter(a => !!a)
  const outDir = argv['output'] || argv['o']
  const transformGlob = argv['transform'] || argv['t']
  const transformer = argv['using'] || argv['u']
  const forkCommand = argv['fork'] || argv['f']
  const spawnCommand = argv['spawn'] || argv['s']
  const debug = argv['d'] || argv['debug']
  const k = argv['k'] || argv['kill']
  const killPorts = Array.isArray(k) ? k : [k].filter(a => !!a)
  const cleaner = argv['cleanup'] || argv['c']
  const wait = argv['wait'] || 3000

  if (watchDirs.length === 0) {
    throw new Error('At least one --watch (-w) option must be specified. -w is a directory to watch.')
  }

  if (!outDir && !Array.isArray(outDir)) {
    throw new Error('A single --output (-o) option should be specified. -o is the output directory.')
  }

  if (Array.isArray(transformGlob)) {
    throw new Error('Only one --transform (-t) option can be specified. -t is a glob specifying which files should be passed through the transformer.')
  }

  if (Array.isArray(transformer)) {
    throw new Error('Only one --using (-u) option must be specified. -u is a JS file with a default export (fpath, contents) => {return contents}.')
  }

  if (forkCommand && spawnCommand) {
    throw new Error('Only one of either --fork or --spawn can be specified, but not both.')
  }

  const command = forkCommand || spawnCommand
  const spawner = (forkCommand && fork) || (spawnCommand && spawn)
  const spawnerType = (forkCommand && 'fork') || (spawnCommand && 'spawn')
  const transform = transformer ? (await import(path.resolve(transformer))).default : async (filepath, outputPath, contents) => {return contents}
  const clean = cleaner ? (await import(path.resolve(cleaner))).default : async (child, spawnerType, signal) => {
    if (signal === 'SIGINT') {
      console.log(`${c.green('[monitor]')} ${c.grey('SIGINT')}`)
      child.kill('SIGINT') // child is expected to exit on its own
    } else {
      // SIGRES signal handling:
      if (spawnerType === 'spawn') {
        console.log(`${c.green('[monitor]')} ${c.grey('SIGTERM')}`)
        child.kill()
      } else if (spawnerType === 'fork') {
        console.log(`${c.green('[monitor]')} ${c.grey('SIGRES')}`)
        child.send('SIGRES') // child is expected to exit on its own
      }
    }
  }

  fs.removeSync(outDir)
  fs.ensureDirSync(outDir)

  let execTimeout
  let child

  process.on("SIGINT", () => {
    if (child) {
      let cleanupTimeout
      const finalPortKilling = async () => {
        if (debug) {
          console.log(`${c.green('[monitor]')} ${c.grey(`exit`)}`)
        }
        if (cleanupTimeout) {
          clearTimeout(cleanupTimeout)
          cleanupTimeout = null
        }

        for (const port of killPorts) {
          console.log(`${c.green('[monitor]')} ${c.grey(`killed port ${port}`)}`)
          await kill(port)
        }

        console.log(`${c.green('[monitor]')} ${c.red('stopped')}`)
        process.exit()
      }

      child.on('exit', finalPortKilling)
      clean(child, spawnerType, 'SIGINT') // should send the SIGINT signal to the child, which causes it to exit.
        .catch(err => {
          console.error(err)
        })

      cleanupTimeout = setTimeout(() => {
        console.log(`${c.green('[monitor]')} ${c.grey(`${c.yellow('timeout')} SIGTERM`)}`)
        child.kill()
      }, wait)
    } else {
      process.exit()
    }
  })

  function queueExec() {
    if (!command) {
      return
    }
    if (execTimeout) {
      clearTimeout(execTimeout)
      execTimeout = null
    }
    const makeChild = () => {
      if (spawner === spawn) {
        console.log(`${c.green('[monitor]')} ${c.yellow('spawn')} ${c.grey(command)}`)
      } else if (spawner === fork) {
        console.log(`${c.green('[monitor]')} ${c.yellow('fork')} ${c.grey(command)}`)
      }
      child = spawner(command.split(' ')[0], command.split(' ').slice(1), {
        stdio: spawner === fork ? ['pipe', process.stdout, process.stderr, 'ipc'] : ['pipe', process.stdout, process.stderr],
      })
    }
    if (child) {
      let killTimeout = setTimeout(() => {
        console.log(`${c.green('[monitor]')} ${c.grey(`${c.yellow('timeout')} SIGTERM`)}`)
        // when the program restarts, if the forked process does not exit, then kill it after `wait` time.
        child.kill()
      }, wait)
      execTimeout = setTimeout(() => {
        // kill child before calling makeChild
        console.log(`${c.green('[monitor]')} ${c.yellow('restarting...')}`)
        child.on('exit', () => {
          if (debug) {
            console.log(`${c.green('[monitor]')} ${c.grey('exit')}`)
          }
          if (killTimeout) {
            clearTimeout(killTimeout)
            killTimeout = null
          }
          child = null
          makeChild()
        })
        clean(child, spawnerType, 'SIGRES')
          .catch(err => {
            console.error(err)
          })
      }, 100)
    } else {
      execTimeout = setTimeout(makeChild, 100)
    }
  }

  function getOutDirPath(filepath) {
    const split = filepath.split(/(?:\/|\\)/)
    return path.resolve(outDir, split.slice(1).join('/'))
  }

  async function pass(f) {
    const isNodeModule = f.includes('node_modules/')
    const originalPath = path.resolve(f)
    const filepath = getOutDirPath(f)
    const shortFilepath = path.relative(process.cwd(), filepath)
    const isDir = fs.lstatSync(originalPath).isDirectory()
    const shouldTransform = transformGlob ? micromatch.isMatch(f, transformGlob) : false
    const shouldLog = debug || (!isNodeModule && !isDir)
    if (isDir) {
      if (!fs.existsSync(filepath)) {
        fs.ensureDirSync(filepath)
        if (shouldLog) {
          console.log(`${c.green('[monitor]')} ${c.grey(`ensured dir ${shortFilepath}`)}`)
        }
      }
    } else if (shouldTransform) {
      if (shouldLog) {
        console.log(`${c.green('[monitor]')} ${c.grey(`${c.blueBright('transpiling')} ${f}`)}`)
      }
      const contents = fs.readFileSync(originalPath, {encoding: 'utf8'})
      const newContents = await transform(originalPath, filepath, contents)
      if (typeof newContents !== 'string') {
        throw new Error('Returned value from custom transformer is not a string.')
      }
      fs.writeFileSync(filepath, newContents, {encoding: "utf-8"})
      queueExec()
    } else {
      fs.copySync(originalPath, filepath)
      if (shouldLog) {
        console.log(`${c.green('[monitor]')} ${c.grey(`${c.blue('copied')} ${f}`)}`)
      }
      queueExec()
    }
  }

  for (const dir of watchDirs) {
    // Tell it what to watch
    if (command) {
      console.log(`${c.green('[monitor]')} ${c.grey(`${c.yellow('watching')} ${dir}`)}`)
    } else {
      console.log(`${c.green('[monitor]')} ${c.grey(`${c.yellow('building')} ${dir} -> ${outDir}`)}`)
    }
    watch.watchTree(dir, {interval: 0.1}, async (f, curr, prev) => {
      if (typeof f === 'string' && f.endsWith('~')) {
        // f is temp file
        return
      }
      if (typeof f == "object" && prev === null && curr === null) {
        // Finished walking the tree on startup
        // Move all files into outDir
        for (const key of Object.keys(f)) {
          await pass(key)
        }
        if (!command) {
          // No command, so exit after building instead of watching.
          console.log(`${c.green('[monitor]')} ${c.grey(`${c.yellow('built')} ${dir} -> ${outDir}`)}`)
          process.exit()
        }
      } else {
        const isNew = prev === null
        const isRemoved = curr.nlink === 0
        const isChanged = !isNew && !isRemoved
        if (isNew || isChanged) {
          // pass through transform
          // place in outDir
          await pass(f)
        } else if (isRemoved) {
          // remove from outDir
          const filepath = getOutDirPath(f)
          fs.removeSync(filepath)
          const shortFilepath = path.relative(process.cwd(), filepath)
          if (prev.nlink === 2) {
            if (debug) {
              console.log(`${c.green('[monitor]')} ${c.grey(`removed dir ${shortFilepath}`)}`)
            }
          } else {
            console.log(`${c.green('[monitor]')} ${c.grey(`${c.red('removed')} ${shortFilepath}`)}`)
            queueExec()
          }
        }
      }
    })
  }
}
