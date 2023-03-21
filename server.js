import express from 'express'
const app = express()

app.get('/', function (req, res) {
  res.send('Hello World')
})

app.listen(3000)
console.log('server started on port 3000')

process.on('message', (m) => {
  if (m === 'SIGRES') {
    // process.exit()
  }
})

process.on('SIGINT', () => {
  // process.exit()
})