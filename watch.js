#!/usr/bin/env node

import minimist from 'minimist'
import watch from 'watch'
import c from 'ansi-colors'
import { fork, spawn } from 'child_process'
import fs from 'fs-extra'
import path from 'path'
import micromatch from 'micromatch'
import { kill } from 'cross-port-killer'
import escalade from 'escalade/sync'
import debounce from 'lodash.debounce'
import { deepEqual } from 'fast-equals'
import delay from 'delay'

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
    [--wait <number>] \\
    [--debug]
    
${c.yellow('Example:')}
    rebuild --watch src --transform 'src/*/src/**/*.{js,mjs}' --transform 'src/web/node_modules/**/*.{js,mjs}' --using transformer.js --output build --fork server.js -k 3000 --wait 500

${c.yellow('Options:')}
    --watch -w        ${c.grey(
      'A glob. All watched files go to the output, but some are transformed along the way. At least one required.'
    )}
    --transform -t    ${c.grey(
      'Files matching this glob are passed through the transformer. Multiple allowed.'
    )}
    --using -u        ${c.grey(
      'The transformer. A JS file. Default: `default export async (inputPath, outputPath, contents) => {return contents}`. Optional.'
    )}
    --output -o       ${c.grey('The output directory. Required.')}
    --fork -f         ${c.grey(
      'The restart command. Optional. If omitted, then rebuild will exit after the first build.'
    )}
    --spawn -s        ${c.grey(
      'The restart command. Optional. If omitted, no rebuilding or monitoring happens.'
    )}
    --cleanup -c      ${c.grey(
      'A JS file. Signature: `default export async (child, spawnerType, signal) => {}`. Optional.'
    )}
    --kill -k         ${c.grey(
      'A port to kill on ctrl+c. Optional. Multiple allowed.'
    )}
    --wait            ${c.grey(
      'How long to wait on file changes and termination before forcefully stopping the process. Default is 3000.'
    )}
    --debug -d        ${c.grey(
      'Log statements about node_modules are excluded by default.'
    )}`)
} else {
  const w = argv['w'] || argv['watch']
  const watchDirs = Array.isArray(w) ? w : [w].filter((a) => !!a)
  const outDir = argv['output'] || argv['o']
  const t = argv['transform'] || argv['t']
  const transformGlobs = Array.isArray(t) ? t : [t].filter((a) => !!a)
  const transformer = argv['using'] || argv['u']
  const f = argv['fork'] || argv['f']
  const forkCommands = Array.isArray(f) ? f : [f].filter((a) => !!a)
  const s = argv['spawn'] || argv['s']
  const spawnCommands = Array.isArray(s) ? s : [s].filter((a) => !!a)
  const debug = argv['d'] || argv['debug']
  const k = argv['k'] || argv['kill']
  const killPorts = Array.isArray(k) ? k : [k].filter((a) => !!a)
  const cleaner = argv['cleanup'] || argv['c']
  const wait = argv['wait'] || 3000

  if (watchDirs.length === 0) {
    throw new Error(
      'At least one --watch (-w) option must be specified. -w is a directory to watch.'
    )
  }

  if (!outDir && !Array.isArray(outDir)) {
    throw new Error(
      'A single --output (-o) option should be specified. -o is the output directory.'
    )
  }

  if (Array.isArray(transformer)) {
    throw new Error(
      'Only one --using (-u) option must be specified. -u is a JS file with a default export (fpath, contents) => {return contents}.'
    )
  }

  const transform = transformer
    ? (await import(path.resolve(transformer))).default
    : async (filepath, outputPath, contents) => {
        return contents
      }
  const clean = cleaner
    ? (await import(path.resolve(cleaner))).default
    : async (child, spawnerType, signal) => {
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

  let children = {} // key is command, value is {type: 'spawn' | 'fork', child}

  let sigintHandled = false
  process.on('SIGINT', () => {
    if (sigintHandled) {
      return
    }
    sigintHandled = true

    let cleanupTimeout

    const finalPortKilling = async () => {
      if (Object.keys(children).length !== 0) {
        // all children should have exited by now.
        return
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

    if (Object.keys(children).length) {
      for (const execution of Object.values(children)) {
        execution.child.on('exit', finalPortKilling)
        clean(execution.child, execution.type, 'SIGINT') // should send the SIGINT signal to the child, which causes it to exit.
          .catch((err) => {
            console.error(err)
          })
      }

      cleanupTimeout = setTimeout(() => {
        console.log(
          `${c.green('[monitor]')} ${c.grey(`${c.yellow('timeout')} SIGTERM`)}`
        )
        for (const execution of Object.values(children)) {
          execution.child.kill()
        }
        // finalPortKilling should be triggered before of exiting children.
      }, wait)
    } else {
      finalPortKilling().catch((err) => {
        console.error(err)
      })
    }
  })

  const makeChildren = async () => {
    for (const command of forkCommands) {
      console.log(
        `${c.green('[monitor]')} ${c.yellow('fork')} ${c.grey(command)}`
      )
      const child = fork(command.split(' ')[0], command.split(' ').slice(1), {
        stdio: ['pipe', process.stdout, process.stderr, 'ipc'],
      })
      const spawnPromise = new Promise((resolve, reject) => {
        child.on('spawn', () => {
          resolve()
        })
        child.on('error', (err) => {
          reject(err)
        })
      })
      const continuePromise = new Promise(async (resolve, reject) => {
        let wait = false
        let pauseForkingTimeout = null
        child.on('message', (message) => {
          if (typeof message === 'object') {
            if (message.pauseForking) {
              console.log(
                `${c.green('[monitor]')} ${c.yellow(`pauseForking`)} ${c.grey(
                  command
                )}`
              )
              wait = true
              pauseForkingTimeout = setTimeout(() => {
                console.log(
                  `${c.green('[monitor]')} ${c.red(
                    `pauseForking timeout`
                  )} ${c.grey(command)}`
                )
                wait = false
              }, 30000)
            } else if (message.resumeForking) {
              if (pauseForkingTimeout) clearTimeout(pauseForkingTimeout)
              pauseForkingTimeout = null
              console.log(
                `${c.green('[monitor]')} ${c.yellow(`resumeForking`)} ${c.grey(
                  command
                )}`
              )
              wait = false
            }
          }
        })
        try {
          await spawnPromise
        } catch (err) {
          reject(err)
        }
        await delay(500) // child has 500ms after spawning to tell parent to pause.
        while (wait) {
          await delay(500)
        }
        resolve()
      })
      child.on('exit', (code) => {
        if (code !== 0) {
          crashDetected = true
          console.log(
            `${c.green('[monitor]')} ${c.red(`crash`)} ${c.grey(command)}`
          )
        } else {
          console.log(`${c.green('[monitor]')} ${c.grey(`exit ${command}`)}`)
        }
        delete children[command]
      })
      children[command] = {
        type: 'fork',
        child,
      }
      await continuePromise
    }

    for (const command of spawnCommands) {
      console.log(
        `${c.green('[monitor]')} ${c.yellow('spawn')} ${c.grey(command)}`
      )
      const child = spawn(command.split(' ')[0], command.split(' ').slice(1), {
        stdio: ['pipe', process.stdout, process.stderr],
      })
      child.on('exit', (code) => {
        if (code !== 0) {
          crashDetected = true
          console.log(
            `${c.green('[monitor]')} ${c.red('crash')} ${c.grey(command)}`
          )
        } else {
          console.log(`${c.green('[monitor]')} ${c.grey(`exit ${command}`)}`)
        }
        delete children[command]
      })
      children[command] = {
        type: 'spawn',
        child,
      }
    }
  }

  let crashDetected = false
  const restart = debounce(() => {
    if (forkCommands.length === 0 && spawnCommands.length === 0) {
      return
    }
    if (Object.keys(children).length) {
      let killTimeout
      if (killTimeout) {
        clearTimeout(killTimeout)
        killTimeout = null
      }
      // kill child before calling makeChildren
      console.log(`${c.green('[monitor]')} ${c.yellow('restarting...')}`)
      for (const execution of Object.values(children)) {
        execution.child.on('exit', () => {
          if (Object.keys(children).length !== 0) {
            // all children should have exited by now.
            return
          }

          if (killTimeout) {
            clearTimeout(killTimeout)
            killTimeout = null
          }
          makeChildren().catch((err) => {
            console.error(err)
          })
        })
        clean(execution.child, execution.type, 'SIGRES').catch((err) => {
          console.error(err)
        })
      }
      killTimeout = setTimeout(() => {
        console.log(
          `${c.green('[monitor]')} ${c.grey(`${c.yellow('timeout')} SIGTERM`)}`
        )
        // when the program restarts, if the forked process does not exit, then kill it after `wait` time.
        for (const execution of Object.values(children)) {
          execution.child.kill()
        }
      }, wait)
    } else {
      if (crashDetected) {
        console.log(
          `${c.green('[monitor]')} ${c.yellow('restarting from crash...')}`
        )
      }
      makeChildren().catch((err) => {
        console.error(err)
      })
    }
    crashDetected = false
  }, 300)

  function getOutDirPath(filepath) {
    const split = filepath.split(/(?:\/|\\)/)
    return path.resolve(outDir, split.slice(1).join('/'))
  }

  async function pass(f) {
    f = path.normalize(f).replaceAll('\\', '/')
    const isNodeModule = f.includes('node_modules')
    const originalPath = path.resolve(f)
    const filepath = getOutDirPath(f)

    const shortFilepath = path.relative(process.cwd(), filepath)
    const isDir = fs.lstatSync(originalPath).isDirectory()
    const isSymlink = fs.lstatSync(originalPath).isSymbolicLink()
    const shouldTransform = !!transformGlobs.find((glob) =>
      micromatch.isMatch(f, glob)
    )
    const shouldLog = debug || (!isNodeModule && !isDir)

    if (isDir || isSymlink) {
      if (!fs.existsSync(filepath)) {
        if (shouldLog) {
          console.log(
            `${c.green('[monitor]')} ${c.grey(`ensuring dir ${shortFilepath}`)}`
          )
        }
        fs.ensureDirSync(filepath)
      }
    } else if (shouldTransform) {
      if (shouldLog) {
        console.log(
          `${c.green('[monitor]')} ${c.grey(
            `${c.blueBright('transpiling')} ${f}`
          )}`
        )
      }
      const contents = fs.readFileSync(originalPath, { encoding: 'utf8' })
      const newContents = await transform(originalPath, filepath, contents)
      if (typeof newContents !== 'string') {
        throw new Error(
          'Returned value from custom transformer is not a string.'
        )
      }
      fs.writeFileSync(filepath, newContents, { encoding: 'utf-8' })
      restart()
    } else {
      if (shouldLog) {
        console.log(
          `${c.green('[monitor]')} ${c.grey(`${c.blue('copying')} ${f}`)}`
        )
      }
      fs.copySync(originalPath, filepath)
      restart()
    }
  }

  async function getProdDeps() {
    //  each subproject in the monorepo should keep track of its own prod deps.
    //  Make watch exclude node_modules so that it doesn't iterate over files in there.
    //  Also make watch only find package.json files.
    //  Now watch fill only find top-level package.json files.
    //  For each top-level package.json found,
    //  create prodDeps[topLevelFolderPath] = {[depFolderPath: string]: boolean}
    //  For each key of prodDeps, aka each topLevelFolderPath,
    //  go into its node_modules folder, and for each depFolderPath,
    //  get the package.json for that dep.
    //  Add its deps to the current prodDeps[topLevelFolderPath] object.
    //  Each new dep that is added is also recorded in a temp array
    //  if it didn't already exist in the current prodDeps[topLevelFolderPath] object.
    //  Repeat the loop for each dep in this array,
    //  also adding its deps to the current prodDeps[topLevelFolderPath] object.
    //  At the end of the loop, if the temp array is empty, there is nothing to follow up on,
    //  So all prod deps for this top-level project have been accounted for, and we can move
    //  on to the next top-level project.

    const prodDeps = {}
    for (const dir of watchDirs) {
      await new Promise((resolve, reject) => {
        watch.watchTree(
          dir,
          {
            ignoreDotFiles: true,
            filter: (file, stat) => {
              const isNodeModule = file.includes('node_modules')
              if (isNodeModule) return false
              return true
            },
          },
          async (f) => {
            if (typeof f === 'object') {
              for (const key of Object.keys(f)) {
                // Only top-level package.json should be found because of filter.
                const isPackageJson = key.endsWith('package.json')
                if (!isPackageJson) continue

                const topLevelFolderPath = path.dirname(key)
                prodDeps[topLevelFolderPath] = {}

                let newlyAdded = {}

                // Add each dep in the top level package.json.
                const topLevelPackage = fs.readJsonSync(key)
                for (const depName of Object.keys(
                  topLevelPackage.dependencies || {}
                )) {
                  const depFolderPath = `${topLevelFolderPath}/node_modules/${depName}`
                  newlyAdded[depFolderPath] = true
                  prodDeps[topLevelFolderPath][depFolderPath] = true
                }

                let nextNewlyAdded
                while (Object.keys(newlyAdded).length) {
                  nextNewlyAdded = {}
                  for (const depFolderPath of Object.keys(newlyAdded)) {
                    // Add the deps of newlyAdded deps.
                    const depPackage = fs.readJsonSync(`${depFolderPath}/package.json`)
                    for (const secondaryDepName of Object.keys(
                      depPackage.dependencies || {}
                    )) {
                      // If two packages have the same dep but with different versions,
                      // then one dep will be installed flat under topLevelFolderPath/node_modules,
                      // but the other version of the dep will be installed nested, in
                      // topLevelFolderPath/node_modules/dep/node_modules/sharedDep

                      // Check nested install first:
                      let secondaryDepFolderPath = `${depFolderPath}/node_modules/${secondaryDepName}`
                      if (!fs.pathExistsSync(secondaryDepFolderPath)) {
                        // If there is no nested install, then it must be a flat install:
                        secondaryDepFolderPath = `${topLevelFolderPath}/node_modules/${secondaryDepName}`
                      }

                      if (!prodDeps[topLevelFolderPath][secondaryDepFolderPath]) {
                        nextNewlyAdded[secondaryDepFolderPath] = true
                        prodDeps[topLevelFolderPath][secondaryDepFolderPath] = true
                      }
                    }
                  }
                  newlyAdded = nextNewlyAdded
                }
              }
            }
            resolve()
          }
        )
      })
    }

    // Symlinked deps via npm link are handled separately.
    // To catch these, go into a top-level project's node_modules, and look for
    // folders which are symlinked.
    // When you find a symlinked folder, add it to the prod deps.
    for (const topLevelFolderPath of Object.keys(prodDeps)) {
      // todo: Do symlinks for orgs need to be considered?
      const folders = fs.readdirSync(`${topLevelFolderPath}/node_modules`)
      for (const folder of folders) {
        if (folder.startsWith('.')) continue
        const folderPath = `${topLevelFolderPath}/node_modules/${folder}`
        const isSymlink = fs.lstatSync(folderPath).isSymbolicLink()
        if (isSymlink) {
          prodDeps[topLevelFolderPath][folderPath] = true
        }
      }
    }

    // If there are any org packages, then the org level has it's own entry in order
    // to make the final watcher's filter easier to implement.
    for (const topLevelFolderPath of Object.keys(prodDeps)) {
      for (const depPackagePath of Object.keys(prodDeps[topLevelFolderPath])) {
        if (depPackagePath.includes('node_modules/@')) {
          // This is an org package.
          const splitted = depPackagePath.split('/')
          splitted.pop()
          const orgPath = splitted.join('/')
          prodDeps[topLevelFolderPath][orgPath] = true
        }
      }
    }

    // Finally, flatten everything:
    const finalDepFolders = {}
    for (const topLevelFolderPath of Object.keys(prodDeps)) {
      for (const depPackagePath of Object.keys(prodDeps[topLevelFolderPath])) {
        finalDepFolders[depPackagePath] = true
      }
    }

    return finalDepFolders
  }

  const prodDeps = await getProdDeps()

  for (const dir of watchDirs) {
    // Tell it what to watch
    if (forkCommands.length || spawnCommands.length) {
      console.log(
        `${c.green('[monitor]')} ${c.grey(`${c.yellow('watching')} ${dir}`)}`
      )
    } else {
      console.log(
        `${c.green('[monitor]')} ${c.grey(
          `${c.yellow('building')} ${dir} -> ${outDir}`
        )}`
      )
    }
    watch.watchTree(
      dir,
      {
        interval: 0.1,
        filter: (file, stat) => {
          const isNodeModule = file.includes('node_modules')
          if (isNodeModule) {
            if (file.endsWith('node_modules')) return true

            // node_modules/.bin is excluded under the assumption that you do not
            // want to bundle .bin in your deploy-bundle.zip
            // because you are probably not running CLI commands in prod.
            // Todo: If you need .bin, then only executables coming from prod deps should be allowed.
            if (file.endsWith('.bin')) return false

            // Match up to node_module/packagename.
            // Examples:
            // src/common/node_modules/@aws-sdk/middleware-retry/
            // src/common/node_modules/middleware-retry/
            const match = (file + '/').match(/^(.+?\/node_modules\/(?:@.+?\/)?.+?\/)/) || []
            const packagePath = match[1].slice(0, -1)
            const include = prodDeps[packagePath]
            return include
          }
          return true
        },
      },
      async (f, curr, prev) => {
        if (typeof f === 'string' && f.endsWith('~')) {
          // f is temp file
          return
        }
        if (typeof f == 'object' && prev === null && curr === null) {
          // Finished walking the tree on startup
          // Move all files into outDir
          for (const key of Object.keys(f)) {
            if (debug) {
              console.log(
                `${c.green('[monitor]')} ${c.grey(`found ${key}`)}`
              )
            }
            if (sigintHandled) break
            await pass(key)
            restart()
          }
          if (!(forkCommands.length || spawnCommands.length)) {
            // No command, so exit after building instead of watching.
            console.log(
              `${c.green('[monitor]')} ${c.grey(
                `${c.yellow('built')} ${dir} -> ${outDir}`
              )}`
            )
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
                console.log(
                  `${c.green('[monitor]')} ${c.grey(
                    `removed dir ${shortFilepath}`
                  )}`
                )
              }
            } else {
              console.log(
                `${c.green('[monitor]')} ${c.grey(
                  `${c.red('removed')} ${shortFilepath}`
                )}`
              )
              restart()
            }
          }
        }
      }
    )
  }
}
