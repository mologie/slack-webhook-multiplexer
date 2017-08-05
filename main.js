#!/usr/bin/env node
//
// Slack Webhook API Multiplexer
// Copyright 2017 Oliver Kuckertz <oliver.kuckertz@softwific.com>
// Released under the MIT License
//

if (!process.env.DEBUG) {
    process.env.DEBUG = '*'
}

const util = require('util')
const http = require('http')
const express = require('express')
const bodyParser = require('body-parser')
const debug = require('debug')('slack-webhook-multiplexer')
const request = require('request-promise-native')
const config = require('./config')
const mux = config.mux
const app = express()
const server = http.createServer(app)

async function handler(req, res, next) {
    // Slack supports 'urlencoded' and JSON-encoded payloads. Handle both cases here.
    let body
    if (req.body.payload) {
        body = JSON.parse(req.body.payload)
    } else {
        body = req.body
    }
    if (!body || typeof body !== 'object') {
        debug('bogus body')
        return res.sendStatus(400)
    }

    // fetch endpoint and validate token
    const endpoint = mux.sourceEndpoints[req.params.endpoint]
    if (!endpoint) {
        debug('no such endpoint')
        return res.sendStatus(404)
    }
    if (endpoint.token && (!req.params.token || mux.sourceTokens[endpoint.token] !== req.params.token)) {
        debug('token mismatch')
        return res.sendStatus(403)
    }

    debug('processing request for endpoint "%s" (%d destinations)', req.params.endpoint, endpoint.muxTo.length)
    let errorCount = 0
    let errorMap = {}
    for (let i = 0; i < endpoint.muxTo.length; i++) {
        const muxDesc = endpoint.muxTo[i]
        const destUrl = mux.destinations[muxDesc.dest]
        if (!destUrl) {
            debug('configuration error: destination "%s" not found', muxDesc.dest)
            return res.sendStatus(500)
        }

        let payload
        if (muxDesc.override) {
            payload = Object.assign({}, body, muxDesc.override)
        } else {
            payload = body
        }

        try {
            debug('will now notify destination "%s" with payload: %s', muxDesc.dest, JSON.stringify(payload))
            let slackResp = await request({
                uri: destUrl,
                method: 'POST',
                body: payload,
                json: true,
                simple: false,
                resolveWithFullResponse: true
            })
            if (slackResp.statusCode == 200) {
                debug('successfully notified destination "%s"', muxDesc.dest)
            }
            else {
                debug('request for destination "%s" failed with status code %d: %s',
                      muxDesc.dest, slackResp.statusCode, slackResp.body)
                errorCount++
                errorMap[muxDesc.dest] = util.format('%s (status %d)', slackResp.body, slackResp.statusCode)
            }
        }
        catch (error) {
            debug('request for destination "%s" failed with error: %s', muxDesc.dest, error.message)
            errorCount++
            errorMap[muxDesc.dest] = util.format('internal error %d: %s', error.code, error.message)
        }
    }

    if (errorCount == 0) {
        return res.sendStatus(200)
    } else {
        return res.json(errorMap).status(500)
    }
}

const forwardRejection = fn => function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next)
}

app.route('/slackmux/:endpoint/:token?')
   .post(bodyParser.json())
   .post(bodyParser.urlencoded({extended: false}))
   .post(forwardRejection(handler))

let socketPath
if (process.env.LISTEN_FDS && parseInt(process.env.LISTEN_FDS, 10) === 1) {
    // systemd socket activation
    server.listen({fd: 3})
}
else if (socketPath = (process.env.SLACKMUX_SOCKET || config.unixSocket)) {
    server.listen(socketPath)
}
else {
    let interface = process.env.SLACKMUX_INTERFACE || config.interface || 'localhost'
    let port = parseInt(process.env.SLACKMUX_PORT, 10) || config.port || 8080
    server.listen(port, interface)
}
