// Vercel entrypoint. vercel.json rewrites every path here, so this one function
// serves the whole app. Locally, use server.js instead.
//
// An Express app is itself a (req, res) handler, which is what Vercel's Node
// runtime expects, so it can be exported directly.
// Instrumentation must be evaluated before anything it instruments. ESM
// evaluates imports in order, so keeping this first is sufficient.
import '../instrumentation.js'

import { createApp } from '../src/app.js'

export default createApp()
