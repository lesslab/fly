const Table = require('cli-table2')
const fs = require('fs')
const mime = require('mime')
const pathToRegexp = require('path-to-regexp')
const { URL } = require('url')
const path = require('path')
const axios = require('axios')
const fastify = require('fastify')()
const colors = require('colors/safe')
const os = require('os')
const { parseFormData, deleteTempFiles } = require('../../lib/multipartParser')

fastify.register(require('fastify-multipart'))
fastify.register(require('fastify-xml-body-parser'))
fastify.register(require('fastify-formbody'))

const MULTIPART_REGEXP = /^multipart\/form-data/i
const TMP_DIR = path.join(os.tmpdir(), 'flyhttp')

module.exports = {
  errors: {
    '404': fs.readFileSync(path.join(__dirname, './pages/404.html')),
    '500': fs.readFileSync(path.join(__dirname, './pages/500.html'))
  },

  configService: {
    name: 'http',
    singleton: false,
    title: 'Http Server',
    port: parseInt(process.env.PORT || 5000, 10),
    address: '127.0.0.1'
  },

  main (event, ctx) {
    const { bind, port, cors } = event
    const { info, warn, error, debug, call, list } = ctx

    try {
      if (!fs.existsSync(TMP_DIR)) {
        fs.mkdirSync(TMP_DIR)
      }
    } catch (err) {
      if (err) {
        const msg = `TEMP_DIR_FAILED: ${TMP_DIR} ${err.message}`
        console.log(msg)
        info(msg)
        process.exit(1)
      }
    }
    info('TEMP_DIR', TMP_DIR)

    fastify.route({
      method: ['GET', 'POST', 'HEAD', 'DELETE', 'PATCH', 'PUT', 'OPTIONS'],
      url: '/*',
      handler: async (request, reply) => {
        const urlObj = new URL('http://' + request.headers.host + request.raw.url)

        let evt = {
          method: request.raw.method.toLowerCase(),
          path: urlObj.pathname,
          origin: urlObj.origin,
          host: urlObj.host,
          domain: urlObj.hostname,
          url: urlObj.href,
          protocol: urlObj.protocol,
          port: urlObj.port,
          ip: String(request.headers['x-forwarded-for'] || request.headers['x-real-ip'] || request.raw.socket.remoteAddress).split(',').shift(),
          headers: request.headers || {},
          body: request.body || {},
          query: request.query || {},
          search: urlObj.search,
          cookies: {}
        }

        info(evt.method, evt.url)

        if (evt.headers.cookie) {
          evt.headers.cookie.split(';').forEach(function (item) {
            const crumbs = item.split('=')
            if (crumbs.length > 1) evt.cookies[crumbs[0].trim()] = crumbs[1].trim()
          })
        }

        let result, err
        let eventId = request.headers['x-fly-id'] || null
        let headers = {}
        const { fn, mode, params, target } = this.Find(evt, ctx, event) || {}
        evt.params = params

        try {
          const isCors = mode === 'cors' || (target && (target.cors !== false || cors))

          if (isCors) {
            headers = {
              'access-control-allow-origin': request.headers['origin'] || '*',
              'access-control-allow-methods': request.headers['access-control-request-method'] || 'GET,HEAD,PUT,PATCH,POST,DELETE',
              'access-control-allow-credentials': 'true',
              'access-control-allow-headers': request.headers['access-control-request-headers'] || '*'
            }

            if (target && typeof target.cors === 'string') {
              headers['access-control-allow-origin'] = target.cors
            } else if (target && typeof target.cors === 'object') {
              Object.keys(target.cors).forEach(key => {
                const value = target.cors[key]
                switch (key) {
                  case 'origin':
                    headers['access-control-allow-origin'] = value
                    break
                  case 'methods':
                    headers['access-control-allow-methods'] = value
                    break
                  case 'headers':
                    headers['access-control-allow-headers'] = value
                    break
                  case 'credentials':
                    if (value === false) {
                      delete headers['access-control-allow-credentials']
                    }
                    break
                }
              })
            }
          }

          if (mode === 'cors') {
            debug(204, 'cors mode')
            // Preflight
            result = { status: 204 }
          } else if (fn) {
            /**
             * Cache define
             */
            if (target.hasOwnProperty('cache') && (
              !target.method ||
              target.method.includes('get') ||
              target.method.includes('head'))) {
              if (['string', 'number'].includes(typeof target.cache) || target.cache === true) {
                headers['cache-control'] = `public, max-age=${target.cache === true ? 600 : target.cache}`
              } else if (!target.cache) {
                headers['cache-control'] = `no-cache, no-store`
              }
            }

            /**
             * multipart/form-data request, parse body, write temp file to temp dir
             */
            const isUpload = target.upload && evt.method === 'post' &&
              typeof evt.headers['content-type'] === 'string' &&
              MULTIPART_REGEXP.test(evt.headers['content-type'])

            let files = {}
            if (isUpload) {
              const formBody = await parseFormData(request, target.upload, TMP_DIR)
              evt.body = formBody.fieldPairs
              evt.files = formBody.files
              files = formBody.files
            }

            // Normal and fallback
            [result, err] = await call(fn.name, evt, { eventId, eventType: 'http' })
            if (err) throw err

            // delete temp files uploaded
            if (isUpload) {
              await deleteTempFiles(files)
            }

            // Handle url
            if (result && result.url) {
              let res
              try {
                res = await axios({ url: result.url }, { responseType: 'stream' })
              } catch (err) {
                res = err.response
              }
              // console.log(res.headers)
              // Object.assign(headers, res.headers)
              Object.assign(result, { status: res.status, body: res.data, url: undefined })
            }
          }

          if (!fn || !result) {
            // Non-exists
            if (this.errors['404']) {
              reply.code(404).type('text/html').send(this.errors['404'])
            } else {
              reply.code(404).type('application/json').send({
                code: 404,
                message: `path not found`
              })
            }
            this.Log(evt, reply, fn)
            return
          } else if (result.constructor !== Object) {
            throw new Error('function return illegal')
          }
        } catch (err) {
          reply.code(500).type('application/json').send({
            code: err.code || 500,
            message: err.message
          })
          error(`backend failed with "[${err.name}] ${err.message}"`)
          this.Log(evt, reply, fn)
          return
        }

        // set headers
        if (result.headers) Object.assign(headers, result.headers)
        Object.keys(headers).forEach(key => reply.header(key, headers[key]))

        // set status
        if (result.status) reply.code(result.status)
        // set type
        if (result.type) reply.type(result.type)

        if (result.redirect) {
          // set redirect
          reply.redirect(result.status || 302, result.redirect)
        } else if (result.file) {
          // return file
          fs.stat(result.file, (err, stat) => {
            if (err) {
              warn('FILE_ERROR', err)
              reply.type('text/html').code(404).send(this.errors['404'])
            } else {
              reply.type(mime.getType(result.file)).send(fs.createReadStream(result.file))
            }
          })
        } else if (!result.body) {
          debug(204, 'no result body')
          // empty body
          if (!result.status) reply.code(204)
          reply.send('')
        } else if (result.hasOwnProperty('body')) {
          // send body
          if (!result.type && typeof result.body === 'string') reply.type('text/html')
          reply.send(result.body)
        } else if (this.errors['500']) {
          // no body and other options response 500
          reply.code(500).type('text/html').send(this.errors['500'])
        } else {
          reply.code(500).type('application/json').send('no body return')
        }
        this.Log(evt, reply, fn)
      }
    })

    return new Promise((resolve, reject) => {
      fastify.listen(port, bind, (err, address) => {
        if (err) return reject(err)

        const table = new Table({
          head: ['Method', 'Path', 'Fn'],
          chars: { 'mid': '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' }
        })

        this.BuildRoutes(list('http')).forEach(route =>
          table.push([route.method.toUpperCase(), route.path, route.fn]))
        console.log(table.toString())
        resolve({ address, $command: { wait: true } })
      })
    })
  },

  Log (event, reply, fn) {
    if (!require('tty').isatty(process.stderr.fd)) return
    let res = reply.res
    console.log([
      res.statusCode < 300 ? colors.green(res.statusCode) : (res.statusCode < 400 ? colors.yellow(res.statusCode) : colors.red(res.statusCode)),
      event.method.toUpperCase(),
      event.path,
      colors.grey(fn ? fn.path : '-')
    ].join(' '))
  },

  BuildRoutes (functions) {
    return functions.map(fn => {
      let e = fn.events.http
      return { method: e.method || 'get', path: e.path, domain: e.domain, fn: fn.name }
    })
  },

  Find (event, ctx, config) {
    let matched
    let secondaryMatched
    let fallbackMatched

    ctx.list('http').some(fn => {
      const matchedInfo = this.Match(event, fn.events.http, config)

      // No match
      if (!matchedInfo.match) return false

      // Set fn
      matchedInfo.fn = fn

      // Match not found and matched length less than current
      if (!matchedInfo.mode && (!matched || matched.length > matchedInfo.length)) {
        matched = matchedInfo
        if (matchedInfo.length === 0) return true
      } else if (matchedInfo.mode === 'fallback' && !fallbackMatched) {
        fallbackMatched = matchedInfo
      } else if (matchedInfo.mode) {
        secondaryMatched = matchedInfo
      }
      return false
    })

    return matched || secondaryMatched || fallbackMatched
  },

  /**
   * Match
   *
   * @param {Object} source
   * @param {Object} target
   */
  Match (source, target, config) {
    if (!target.path && target.default) target.path = target.default
    if (!target.method) target.method = 'get'
    if (!target.path) return false

    // Normalrize method
    target.method = target.method.toLowerCase()

    if (target.path[0] !== '/') {
      console.warn('warn: http path is not start with "/", recommend to add it')
      target.path = '/' + target.path
    }

    let keys = []
    let regex = pathToRegexp(target.path, keys)
    let pathMatched = regex.exec(source.path)
    let mode = null
    let match = false
    let matchLength = 0
    let params = {}

    if (pathMatched) {
      matchLength = (pathMatched[1] || '').length
      keys.forEach((key, i) => (params[key.name] = pathMatched[i + 1]))

      // method match
      if (!match && (target.method.includes(source.method) || target.method === '*')) {
        match = true
      }

      // cors match
      if (!match && source.method === 'options' && (target.cors || config.cors)) {
        match = true
        mode = 'cors'
      }

      // head match
      if (!match && source.method === 'head' && (target.method.includes('get') || target.method === '*')) {
        match = true
        mode = 'head'
      }

      if (!match && target.fallback) {
        match = true
        mode = 'fallback'
      }
    }

    return { match, length: matchLength, mode, path: !!pathMatched, params, target, source }
  }

}
