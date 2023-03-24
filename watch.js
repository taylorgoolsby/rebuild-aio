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
    --watch -w        ${c.grey(
      'A glob. All watched files go to the output, but some are transformed along the way. At least one required.'
    )}
    --transform -t    ${c.grey(
      'Files matching this glob are passed through the transformer. Optional.'
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
  const transformGlob = argv['transform'] || argv['t']
  const transformer = argv['using'] || argv['u']
  const forkCommand = argv['fork'] || argv['f']
  const spawnCommand = argv['spawn'] || argv['s']
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

  if (Array.isArray(transformGlob)) {
    throw new Error(
      'Only one --transform (-t) option can be specified. -t is a glob specifying which files should be passed through the transformer.'
    )
  }

  if (Array.isArray(transformer)) {
    throw new Error(
      'Only one --using (-u) option must be specified. -u is a JS file with a default export (fpath, contents) => {return contents}.'
    )
  }

  if (forkCommand && spawnCommand) {
    throw new Error(
      'Only one of either --fork or --spawn can be specified, but not both.'
    )
  }

  const command = forkCommand || spawnCommand
  const spawner = (forkCommand && fork) || (spawnCommand && spawn)
  const spawnerType = (forkCommand && 'fork') || (spawnCommand && 'spawn')
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

  let execTimeout
  let child

  let sigintHandled = false
  process.on('SIGINT', () => {
    if (sigintHandled) {
      return
    }
    sigintHandled = true

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
          console.log(
            `${c.green('[monitor]')} ${c.grey(`killed port ${port}`)}`
          )
          await kill(port)
        }

        console.log(`${c.green('[monitor]')} ${c.red('stopped')}`)
        process.exit()
      }

      child.on('exit', finalPortKilling)
      clean(child, spawnerType, 'SIGINT') // should send the SIGINT signal to the child, which causes it to exit.
        .catch((err) => {
          console.error(err)
        })

      cleanupTimeout = setTimeout(() => {
        console.log(
          `${c.green('[monitor]')} ${c.grey(`${c.yellow('timeout')} SIGTERM`)}`
        )
        child.kill()
        process.exit()
      }, wait)
    } else {
      process.exit()
    }
  })

  const makeChild = () => {
    if (spawner === spawn) {
      console.log(
        `${c.green('[monitor]')} ${c.yellow('spawn')} ${c.grey(command)}`
      )
    } else if (spawner === fork) {
      console.log(
        `${c.green('[monitor]')} ${c.yellow('fork')} ${c.grey(command)}`
      )
    }
    child = spawner(command.split(' ')[0], command.split(' ').slice(1), {
      stdio:
        spawner === fork
          ? ['pipe', process.stdout, process.stderr, 'ipc']
          : ['pipe', process.stdout, process.stderr],
    })
  }

  const restart = debounce(() => {
    if (!command) {
      return
    }
    if (child) {
      let killTimeout
      if (killTimeout) {
        clearTimeout(killTimeout)
        killTimeout = null
      }
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
      clean(child, spawnerType, 'SIGRES').catch((err) => {
        console.error(err)
      })
      killTimeout = setTimeout(() => {
        console.log(
          `${c.green('[monitor]')} ${c.grey(`${c.yellow('timeout')} SIGTERM`)}`
        )
        // when the program restarts, if the forked process does not exit, then kill it after `wait` time.
        child.kill()
      }, wait)
    } else {
      makeChild()
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
    const shouldTransform = transformGlob
      ? micromatch.isMatch(f, transformGlob)
      : false
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

  for (const dir of watchDirs) {
    // Tell it what to watch
    if (command) {
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
            // if (file.includes('graphql-directive-private')) {
            //   return false
            // }
            const isProdDep = isProductionDependency(file)
            // if (file.includes('src/backend/node_modules/@graphql-tools/utils')) {
            //   console.log('file', file)
            //   console.log('isProdDep', isProdDep)
            // }
            if (!isProdDep) {
              return false
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
            // console.log('key', key)
            if (sigintHandled) break
            await pass(key)
            restart()
          }
          if (!command) {
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
