// Vercel entrypoint. vercel.json rewrites every path here, so this one function
// serves the whole app. Locally, use server.js instead.
//
// An Express app is itself a (req, res) handler, which is what Vercel's Node
// runtime expects, so it can be exported directly.
import { createApp } from '../src/app.js'

export default createApp()
