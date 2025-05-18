import { Meteor } from "meteor/meteor"
import bodyParser from "body-parser"
import { WebApp } from "meteor/webapp"
import { Messages } from "/imports/api/messages.js"
import { exec } from "child_process"
import { promisify } from "util"
import axios from "axios"
import md5 from "md5"
import iconv from "iconv-lite"

const execFileAsync = promisify(require("child_process").execFile)

Meteor.startup(async () => {
  try {
    // 1. TTL index: deletes messages after 24 hours
    // await Messages.createIndexAsync(
    //   { receivedAt: 1 },
    //   { expireAfterSeconds: 60 * 60 * 24 } // 24 hours
    // )

    // 2. Compound index for deduplication
    await Messages.createIndexAsync({
      from: 1,
      body: 1,
      receivedAt: 1,
    })

    console.log("✅ Indexes successfully created")
  } catch (err) {
    console.error("❌ Failed to create indexes:", err.message)
  }

  Meteor.setInterval(function () {
    pollRouter()
  }, 1000)
})

const pollRouter = async function () {
  const passwordPlain = Meteor.settings.private.routerPWD
  const passwordHashed = md5(passwordPlain)

  let cookieString

  try {
    const res = await axios.post(
      "http://192.168.1.5/login/Auth",
      {
        username: "admin",
        password: passwordHashed,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Referer: "http://192.168.1.5/index.html",
          Origin: "http://192.168.1.5",
          "X-Requested-With": "XMLHttpRequest",
        },
        validateStatus: null,
      }
    )

    const cookies = res.headers["set-cookie"]
    if (res.data && res.data.errCode === 0 && cookies) {
      cookieString = cookies.map((c) => c.split(";")[0]).join("; ")
      console.log("✅ Login successful")
      console.log("🔐 Auth cookie:", cookieString)
    } else {
      console.error("❌ Login failed:", res.data)
      return
    }
  } catch (err) {
    console.error("❌ Error logging in:", err.message)
    return
  }

  try {
    // Step 2 – Fetch SMS using curl
    const rand = Math.random()
    const url = `http://192.168.1.5/goform/getModules?rand=${rand}&currentPage=1&pageSizes=200&modules=smsList`

    const { stdout } = await execFileAsync(
      "curl",
      ["-s", url, "-H", "Referer: http://192.168.1.5/index.html", "-H", "X-Requested-With: XMLHttpRequest", "-H", `Cookie: ${cookieString}`, "-H", "User-Agent: Mozilla/5.0", "-H", "Accept: application/json, text/plain, */*"],
      { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 }
    )

    const decoded = iconv.decode(stdout, "utf-8") // or try "latin1", "gbk", etc.
    console.log("📦 Raw decoded data (first 600 chars):", decoded.slice(0, 600))
    let data
    try {
      data = JSON.parse(decoded)
    } catch (e) {
      console.error("❌ Failed to parse decoded response:", decoded.slice(0, 300))
      throw e
    }

    const phoneList = data?.smsList?.phoneList || []

    const latestBySender = new Map()

    phoneList.forEach((entry) => {
      const number = entry.phone
      const note = entry.note?.[0] // safely get the only message

      if (note) {
        latestBySender.set(number, {
          number,
          content: note.content,
          time: new Date(note.time * 1000),
        })
      }
    })

    for (const { number, content, time } of latestBySender.values()) {
      const exists = await Messages.findOneAsync({
        from: number,
        body: content,
        receivedAt: time,
      })

      if (exists) {
        console.log(`⏭️ Already exists: ${number} – ${content.slice(0, 30)}...`)
        continue
      }

      const _id = await Messages.insertAsync({
        from: number,
        fromSafe: obfuscateNumber(number),
        body: content,
        receivedAt: time,
      })

      console.log(`✅ Inserted new message from ${number} (ID: ${_id})`)
    }

    // console.log("\n📨 Latest message from each sender:\n")
    // for (const { number, content, time } of latestBySender.values()) {
    //   console.log(`📱 ${number} – ${time.toLocaleString()}\n📝 ${content}\n`)
    // }
  } catch (err) {
    console.error("❌ Failed to fetch SMS with curl:", err.message)
  }
}

const obfuscateNumber = function (number) {
  // Strip everything except digits
  const clean = number.replace(/\D+/g, "")

  // Ensure it's at least 5 digits to preserve 3+2
  if (clean.length < 5) return "xx xx xx xx xx"

  const first3 = clean.slice(0, 3)
  const last2 = clean.slice(-2)
  const middleLength = clean.length - 5

  // Replace middle digits with x’s (grouped by 2s if needed)
  let middle = "x".repeat(middleLength)
  middle = middle.replace(/(..)/g, "$1 ").trim()

  return `${first3} ${middle} ${last2}`.replace(/\s+/g, " ")
}
