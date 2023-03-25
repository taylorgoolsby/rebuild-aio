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
import { deepEqual } from 'fast-equals';
import { diff } from 'deep-object-diff';

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

  const makeChildren = () => {
    for (const command of forkCommands) {
      console.log(
        `${c.green('[monitor]')} ${c.yellow('fork')} ${c.grey(command)}`
      )
      const child = fork(command.split(' ')[0], command.split(' ').slice(1), {
        stdio: ['pipe', process.stdout, process.stderr, 'ipc'],
      })
      child.on('exit', () => {
        if (debug) {
          console.log(`${c.green('[monitor]')} ${c.grey('exit')}`)
        }
        delete children[command]
      })
      children[command] = {
        type: 'fork',
        child,
      }
    }

    for (const command of spawnCommands) {
      console.log(
        `${c.green('[monitor]')} ${c.yellow('spawn')} ${c.grey(command)}`
      )
      const child = spawn(command.split(' ')[0], command.split(' ').slice(1), {
        stdio: ['pipe', process.stdout, process.stderr],
      })
      child.on('exit', () => {
        if (debug) {
          console.log(`${c.green('[monitor]')} ${c.grey('exit')}`)
        }
        delete children[command]
      })
      children[command] = {
        type: 'spawn',
        child,
      }
    }
  }

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
          makeChildren()
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
      makeChildren()
    }
  }, 300)

  function getOutDirPath(filepath) {
    const split = filepath.split(/(?:\/|\\)/)
    return path.resolve(outDir, split.slice(1).join('/'))
  }

  /*
  A file is found in node_modules.
  It might be a dependency of a dependency, e.g. /node_modules/package/node_modules.
  This functions tells whether or not this file is in a node_module which is a
  production dependency, which means it is a file needed for production.
  This means that it appears in a chain of dependencies, not devDependencies.

  However, this chain can possible stop before reaching the top level of the project
  in a monorepo structure.

  In both cases, monorepo or not, the concept of "top-level" for a sub-project can
  be defined as when the path does not contain "node_modules".

  Sometimes a dependency is a symlink because of `npm link`.
  These do not appear in the package.json.
  If a symlink is encountered, it is considered to be part of prod.
  * */
  function isProductionDependency(input) {
    // All node_modules used in productions are installed flat,
    // so any paths which have a second level of node_modules are not allowed.

    const nodeModulesCount = input.match(/node_modules/g)?.length || 0
    if (nodeModulesCount > 1) {
      return false
    }
    return true

    // input = path.normalize(input).replaceAll('\\', '/')
    // // console.log('input', input)
    // let nodeModulesCount = 0
    // let firstEncounter = false
    // let secondEncounter = false
    // let moduleName
    // let notDep = false
    // escalade(input, (dir, names) => {
    //   if (dir.includes('src/backend/node_modules/@graphql-tools/utils') || moduleName === '@graphql-tools/utils') {
    //     console.log('input', input)
    //     console.log('dir', dir)
    //     console.log('names', names)
    //   }
    //
    //   const topLevel = !dir.includes('node_modules')
    //   const firstLevel = dir.match(/node_modules/g)?.length === 1
    //   const topLevelReached = topLevel && names.includes('node_modules')
    //   const aboveTopLevel = topLevel && !topLevelReached
    //   if (aboveTopLevel) {
    //     // If the dir does not contain node_modules,
    //     // then the top-level has been reached,
    //     // if node_modules is in names.
    //     return '_'
    //   }
    //   if (names.includes('package.json')) {
    //     if (!firstEncounter) {
    //       const pkgPath = path.resolve(dir, 'package.json')
    //       const pkg = fs.readJsonSync(pkgPath)
    //       moduleName = pkg.name
    //       if (moduleName) {
    //         firstEncounter = true
    //       }
    //
    //       if (dir.includes('src/backend/node_modules/@graphql-tools/utils') || moduleName === '@graphql-tools/utils') {
    //         console.log('first')
    //         console.log('pkg', pkg)
    //       }
    //
    //     } else {
    //       const pkgPath = path.resolve(dir, 'package.json')
    //       const pkg = fs.readJsonSync(pkgPath)
    //       if (pkg.name) {
    //         secondEncounter = true
    //       }
    //       const isDep =
    //         !!pkg.dependencies && moduleName && pkg.dependencies[moduleName]
    //
    //       if (dir.includes('src/backend/node_modules/@graphql-tools/utils') || moduleName === '@graphql-tools/utils') {
    //         console.log('pkg', pkg)
    //         console.log('isDep', isDep)
    //       }
    //
    //       if (!isDep) {
    //         notDep = true
    //         return '_' // dummy to break out.
    //       }
    //       moduleName = pkg.name // ready for next encounter
    //     }
    //   } else if (dir.endsWith('node_modules')) {
    //     // dir is one level above node_modules
    //     nodeModulesCount++
    //   } else if (dir === process.cwd()) {
    //     // done
    //     return '_'
    //   }
    //
    //   if (dir.includes('src/backend/node_modules/@graphql-tools/utils') || moduleName === '@graphql-tools/utils') {
    //     console.log('asdas')
    //   }
    //
    //   const isSymLink = fs.lstatSync(dir).isSymbolicLink()
    //   if (isSymLink && firstLevel) {
    //     // If a symlink is found in node_modules
    //     // then it is considered to be prod
    //     // if the previous checks in lower tree levels
    //     // were found to also be prod.
    //     if (dir.includes('src/backend/node_modules/@graphql-tools/utils') || moduleName === '@graphql-tools/utils') {
    //       console.log('isSymLink')
    //     }
    //     return '_' // dummy to break out.
    //   }
    // })
    // if (notDep) {
    //   // Unable to climb tree without encountering non-dep.
    //   return false
    // } else {
    //   return true
    // }
    // if (nodeModulesCount === 0) {
    //   // top-level file
    //   return true
    // }
    // if (nodeModulesCount === 1 && (/node_modules(?=(?:\/[^./]+)?(?:\/[^./]+)?$)/gm).test(input)) {
    //   // this is a path which ends with, examples:
    //   // asdasd/node_modules/@asd/as
    //   // node_modules/as
    //   // node_modules
    //   // but not:
    //   // node_modules/@asd/as/asd
    //   // node_modules/@asd/asd.asd
    //   // node_modules/file.asd
    //   // node_modules/.bin
    //   return true
    // }
    // if (firstEncounter && !secondEncounter) {
    //   // top-level package.json, so it is part of production.
    //   return true
    // }
  }

  async function getParentPackageJson(input) {
    let firstEncounter = false
    const pkgPath = await escalade(input, (dir, names) => {
      if (names.includes('package.json')) {
        if (!firstEncounter) {
          firstEncounter = true
        } else {
          return 'package.json'
        }
      }
    })
    return fs.readJsonSync(pkgPath)
  }

  async function getModuleName(input) {
    const pkgPath = await escalade(input, (dir, names) => {
      if (names.includes('package.json')) {
        return 'package.json'
      }
    })
    const pkg = fs.readJsonSync(pkgPath)
    return pkg.name
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

  // When it finds the top-level package.json, it reads the dependencies field,
  // adding entries to the prod list which are paths to the dir containing the package.json.
  //
  // Any time a package.json inside node_modules is found, it checks the prod list for a matching path.
  // If the path matches, it is a prod dep, and all of its dependencies are added to the prod list.
  // These dependencies may or may not be in the flat first-level of node_modules.
  // So a check is performed. It looks for the package.json in the local-level node_modules.
  // This mirrors how node's require resolution algorithm works.
  // If no module is found in the local-level, then it goes up to the next node_modules level and checks there.
  // It continues these checks until it reaches the first-level node_modules.
  // When it finds an existing path, then it adds that path to the prod list.
  //
  // This loop continues running until the prod list stops changing.
  async function getProdDeps() {
    let prodDeps = {}
    let nextProdDeps = {} // key is dir path, value is version
    do {
      prodDeps = {...nextProdDeps}

      await new Promise((resolve) => {
        for (const dir of watchDirs) {
          watch.watchTree(dir, {
            ignoreDotFiles: true,
          }, async (f) => {
            if (typeof f === 'object') {
              for (const file of Object.keys(f)) {
                const isNodeModules = file.includes('node_modules')
                const isPackageJson = file.endsWith('package.json')
                const nodeModulesCount = file.match(/node_modules/g)?.length || 0
                const isSymLinkDep = nodeModulesCount === 1 && fs.lstatSync(file).isSymbolicLink()
                if (isPackageJson && !isNodeModules) {
                  // top-level package.json
                  const pkg = fs.readJsonSync(file)
                  for (const moduleName of Object.keys(pkg.dependencies || {})) {
                    const topLevelDir = path.resolve(file, '..')
                    const packagePath = path.resolve(topLevelDir, 'node_modules', moduleName, 'package.json')
                    nextProdDeps[packagePath] = (pkg.dependencies || {})[moduleName]
                  }

                  // Also include top-level devDependencies since these may be used
                  // for custom build scripts:
                  // for (const moduleName of Object.keys(pkg.devDependencies || {})) {
                  //   const topLevelDir = path.resolve(file, '..')
                  //   const packagePath = path.resolve(topLevelDir, 'node_modules', moduleName, 'package.json')
                  //   nextProdDeps[packagePath] = (pkg.devDependencies || {})[moduleName]
                  // }
                } else if (isNodeModules && !isPackageJson) {
                  if (isSymLinkDep) {
                    // Sometimes a dev needs to use npm link pkg to work on a fork of a package locally.
                    // In this case, the dep does not appear in the top-level package.json,
                    // but it appears in the first-level node_modules as a symlink.
                    const packagePath = path.resolve(file, 'package.json')
                    const pkg = fs.readJsonSync(packagePath)
                    nextProdDeps[packagePath] = pkg.name
                  }
                } else if (isNodeModules && isPackageJson) {
                  // dependency's package.json
                  const pkg = fs.readJsonSync(file)
                  const currentFolderPath = path.resolve(file, '..') // take package.json off the end

                  if (nextProdDeps[path.resolve(file)]) {
                    // This dep is in the prod list, so add its deps to the list also.
                    for (const moduleName of Object.keys(pkg.dependencies || {})) {
                      // Look for this dep's dep starting with the local node_modules.
                      let startingPath = path.resolve(currentFolderPath, 'node_modules')
                      if (!fs.existsSync(startingPath)) {
                        startingPath = path.resolve(currentFolderPath)
                      }
                      const packagePath = escalade(startingPath, (dir, names) => {
                        // root/node_modules/pkgA/node_modules/pkgB
                        // root/node_modules/pkgA/node_modules
                        // root/node_modules/pkgA
                        // root/node_modules
                        // root

                        if (!dir.includes('node_modules')) {
                          // gone too far, stop.
                          return null
                        }

                        if (dir.endsWith(`node_modules`)) {
                          // within any level of node_modules,
                          // check if this module is in the folder.
                          const packagePath = path.resolve(dir, moduleName, 'package.json')
                          if (fs.existsSync(packagePath)) {
                            // The module has been found.
                            return packagePath
                          }
                        }
                      })
                      nextProdDeps[packagePath] = (pkg.dependencies || {})[moduleName]
                    }
                  }
                }
              }
              resolve()
            }
          })
        }
      })
      for (const dir of watchDirs) {
        watch.unwatchTree(dir)
      }

    } while (!deepEqual(prodDeps, nextProdDeps))

    return nextProdDeps
  }

  const prodDeps = await getProdDeps()

  // console.log('prodDeps', prodDeps)

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
          // file = path.resolve(file)
          const isNodeModule = file.includes('node_modules')
          if (isNodeModule) {
            // The file might be a path like root/node_modules/pkgA/src/file.js
            // So escalade is used to go up to root/node_modules/pkgA,
            // which is the folder containing the nearest package.json
            const packagePath = escalade(file, (dir, names) => {
              if (!dir.includes('node_modules')) {
                // finding a package.json after this point is not valid.
                return null
              }

              if (names.includes('package.json')) {
                const packagePath = path.resolve(dir, 'package.json')
                const pkg = fs.readJsonSync(packagePath)
                if (pkg.name && pkg.version) {
                  // sometimes, a bare package.json might exist in order
                  // that file within a folder are treated with a different type.
                  // For example, it would contain, {"type": "module"}
                  // These kinds of package.jsons are not considered.
                  // Only package.jsons with a name and version are considered.
                  return packagePath
                }
              }
            })
            if (packagePath) {
              // if moduleFolder could not be found,
              // it is likely because escalade started on a path like root/node_modules/@org or root/node_modules.
              const isProdDep = prodDeps[packagePath]
              if (!isProdDep) {
                // console.log('moduleFolder', packagePath)
                return false
              }
            }
          } else {
            const isBin = file.includes('.bin')
            if (isBin) {
              return false
            }
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
