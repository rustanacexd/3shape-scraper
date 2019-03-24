/* eslint no-undef: 1 */
const puppeteer = require('puppeteer')
const fs = require('fs')
// const Path = require('path')
const wretch = require('wretch')
const cheerio = require('cheerio')
require('dotenv').config()

global.fetch = require('node-fetch')

const LOCAL_JSON = `${__dirname}/local.json`
const TIMEOUT = 60000

const refreshToken = async () => {
  const blockedResourceTypes = [
    'image',
    'media',
    'font',
    'texttrack',
    'object',
    'beacon',
    'csp_report',
    'imageset'
  ]

  const browser = await puppeteer.launch({
    args: [
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu'
    ]
  })

  const page = await browser.newPage()
  await page.setRequestInterception(true)
  page.on('request', request => {
    if (blockedResourceTypes.indexOf(request.resourceType()) !== -1) {
      request.abort()
    } else {
      request.continue()
    }
  })

  const loginSelector = 'app-login div:nth-child(1) a'
  console.log('Visiting the login page')
  await page.goto('https://beta-portal.3shapecommunicate.com/login', { timeout: TIMEOUT })

  console.log('waiting for login button selector')
  await page.waitForSelector(loginSelector, { timeout: TIMEOUT })

  console.log('clicking login button')
  await page.click(loginSelector)

  console.log('waiting for email and password selectors')
  await page.waitForSelector('#Email', { timeout: TIMEOUT })
  await page.waitForSelector('#Password', { timeout: TIMEOUT })

  console.log('typing email and password')
  await page.type('#Email', process.env.EMAIL)
  await page.type('#Password', process.env.PASSWORD)

  await page.click('button[type=submit]')
  console.log('logging in....')
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: TIMEOUT })

  console.log('we are in. parsing local storage')
  const storage = await page.evaluate(() => {
    let values = {}
    // TODO: might parse more localstorage data
    // eslint-disable no-undef
    for (var i = 0, len = localStorage.length; i < len; ++i) {
      if (localStorage.key(i) === 'token') {
        values[localStorage.key(i)] = localStorage.getItem(localStorage.key(i))
      }
    }
    return values
  })

  console.log('writing token ...')
  fs.writeFileSync(LOCAL_JSON, JSON.stringify(storage))
  console.log('closing browser...')
  await browser.close()
}

const fetchToken = async () => {
  try {
    let content = fs.readFileSync(LOCAL_JSON)
    if (content.length <= 10) {
      await refreshToken()
    }

    content = fs.readFileSync(LOCAL_JSON)
    return JSON.parse(content).token
  } catch (error) {
    console.log(new Error(error.message))
  }
}

const fetchPatientData = async (patientName = '') => {
  const token = await fetchToken()
  const { Cases, Count } = await wretch('https://ammetadata.3shapecommunicate.com/api/cases/search')
    .auth(`Bearer ${token}`)
    .query({
      page: 0,
      searchString: patientName,
      caseStates: 'Sent,Created,Received,Approved,Rejected,Designed,Manufactured'
    })
    .get()
  // their API uses 500 status code instead of 401
    .internalError(async (_, req) => {
      await refreshToken()
      const data = await req.auth(`Bearer ${await fetchToken()}`).get().json(data => data)
      return data
    })
    .json(data => data)
    .catch(error => {
      console.log(new Error(error.message))
    })

  return { cases: Cases, count: Count }
}

const matchByName = async (patientData) => {
  try {
    console.log(`parsing patient data ${patientData.PatientName}`)
    const stlAttachments = patientData.Attachments.filter(obj => obj.FileType === 'stl')

    // TODO: ask Dan/Parker about what to do with files?
    // const fileBlobPromises = stlAttachments.map(obj => downloadFile(obj.Href))
    // const blobs = await Promise.all(fileBlobPromises)
    return {
      name: patientData.PatientName,
      // blobs,
      attachmentsHrefs: stlAttachments.map(obj => obj.Href),
      fullNameMatch: true
    }
  } catch (error) {
    console.log(new Error(error.message))
  }
}

const matchByBirthDate = async (cases, birthdayInput) => {
  let patients = []
  try {
    for (const patientData of cases) {
      const stlAttachments = patientData.Attachments.filter(obj => obj.FileType === 'stl')
      const orderForm = patientData.Attachments.filter(obj => obj.Name === 'PrintableOrderForm.html')[0]
      patients.push({
        id: patientData.Id,
        href: orderForm.Href,
        attachments: stlAttachments.map(obj => obj.Href),
        fullNameMatch: true
      })
    }
    const data = await parseOrderform(patients)
    const matchedPatient = data.filter(obj => obj.birthday === birthdayInput)
    if (matchedPatient.length > 0) {
      return cases.filter(obj => obj.ThreeShapeOrderNo === matchedPatient[0].caseNumber).map(obj => {
        const stlAttachments = obj.Attachments.filter(obj => obj.FileType === 'stl')
        return {
          name: obj.PatientName,
          attachmentsHrefs: stlAttachments.map(obj => obj.Href),
          fullNameMatch: false
        }
      })
    }

    return { message: 'no match found' }
  } catch (error) {
    console.log(new Error(error.message))
  }
}

const parseOrderform = async (data) => {
  function parseBirthdayData (data) {
    const $ = cheerio.load(data)
    const birthday = $('.tableMain tr:nth-child(2) > td > table > tbody > tr:nth-child(3) > td:nth-child(4)').text()
    const caseNumber = $('.tableMain tr:nth-child(2) > td > table > tbody > tr:nth-child(1) > td:nth-child(4)').text()
    return { birthday, caseNumber }
  }
  const token = await fetchToken()
  const bPromises = []
  for (const d of data) {
    bPromises.push(wretch(d.href)
      .auth(`Bearer ${token}`)
      .get()
      .internalError(async (_, req) => {
        await refreshToken()
        const data = await req.auth(`Bearer ${await fetchToken()}`).get().text(data => parseBirthdayData(data))
        return data
      })
      .text(data => parseBirthdayData(data))
      .catch(error => {
        console.log(new Error(error.message))
      }))
  }

  return Promise.all(bPromises)
}

const downloadFile = async (fileUrl) => {
  console.log(`downloading ${fileUrl}`)
  const token = await fetchToken()
  return wretch(fileUrl)
    .auth(`Bearer ${token}`)
    .get()
    .internalError(async (_, req) => {
      await refreshToken()
      return req.auth(`Bearer ${await fetchToken()}`).get().blob(blob => blob)
    })
    .blob(blob => blob)
    .catch(error => {
      console.log(new Error(error.message))
    })
}

// Main
// put logic of the future api endpoint here?
(async () => {
  // input place holder from api
//   const nameInput = 'Karyn'
  const nameInput = 'Rustan'
  const birthdayInput = '5/21/1992'

  try {
    const { cases, count } = await fetchPatientData(nameInput)
    if (count > 0) {
      const data = await matchByName(cases[0])
      console.log(JSON.stringify(data))
    } else {
      console.log('results for the given name is empty, lets match by birthdate')
      const { cases } = await fetchPatientData()
      const data = await matchByBirthDate(cases, birthdayInput)
      console.log(JSON.stringify(data))
    }
  } catch (error) {
    console.log(new Error(error.message))
  }
})()
