require("dotenv").config();

const express = require("express");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const CryptoJS = require("crypto-js");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const AWS = require("aws-sdk");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

/* ================= AWS S3 ================= */

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

const s3 = new AWS.S3();

const BUCKET = process.env.S3_BUCKET;

const USER_KEY = "__system__/user.json";

/* ================= CONFIG ================= */

const upload = multer({ storage: multer.memoryStorage() });



const SECRET = "SUPER_SECRET_KEY";
const FILE_SECRET = "FILE_SECRET_KEY";


/* ================= INIT USER ================= */

async function initUser(){

  try{

    await s3.getObject({
      Bucket: BUCKET,
      Key: USER_KEY
    }).promise();

  }catch{

    const hash = bcrypt.hashSync("1234",10);

    const data = JSON.stringify({ pin: hash });

    await s3.putObject({
      Bucket: BUCKET,
      Key: USER_KEY,
      Body: data,
      ContentType: "application/json"
    }).promise();

    console.log("Created default user in S3");
  }
}

initUser();



/* ================= AUTH ================= */

function auth(req, res, next) {

  const h = req.headers.authorization;

  if (!h) return res.sendStatus(403);

  try {
    jwt.verify(h, SECRET);
    next();
  } catch {
    res.sendStatus(403);
  }
}


/* ================= LOGIN ================= */

app.post("/login", async (req, res) => {

  const { pin } = req.body;

  const obj = await s3.getObject({
  Bucket: BUCKET,
  Key: USER_KEY
}).promise();

const user = JSON.parse(obj.Body.toString());


  if (!bcrypt.compareSync(pin, user.pin))
    return res.status(401).json({ msg: "Wrong PIN" });

  const token = jwt.sign(
    { user: "me" },
    SECRET,
    { expiresIn: "6h" }
  );

  res.json({ token });
});


/* ================= UPLOAD ================= */

app.post("/upload", auth, upload.single("file"), async (req, res) => {

  const relPath = req.body.path || req.file.originalname;

  const data = req.file.buffer.toString("base64");

  const encrypted = CryptoJS.AES.encrypt(
    data,
    FILE_SECRET
  ).toString();


  await s3.putObject({

    Bucket: BUCKET,
    Key: relPath,
    Body: encrypted,
    ContentType: "text/plain"

  }).promise();


  res.json({ msg: "Uploaded to S3" });
});


/* ================= LIST FILES ================= */

app.get("/files", auth, async (req, res) => {

  const dir = req.query.path || "";

  const prefix = dir ? dir + "/" : "";

  const data = await s3.listObjectsV2({
    Bucket: BUCKET,
    Prefix: prefix,
    Delimiter: "/"
  }).promise();


  const result = [];

  if (data.CommonPrefixes) {
    data.CommonPrefixes.forEach(p => {
      result.push({
        name: p.Prefix.replace(prefix, "").replace("/", ""),
        isDir: true
      });
    });
  }

  if (data.Contents) {
    data.Contents.forEach(o => {

      if (o.Key === prefix) return;

      const name = o.Key.replace(prefix, "");

      if (!name.includes("/")) {
        result.push({
          name,
          isDir: false
        });
      }
    });
  }

  res.json(result);
});


/* ================= DOWNLOAD ================= */

app.get("/download", auth, async (req, res) => {

  const key = req.query.path;

  const obj = await s3.getObject({
    Bucket: BUCKET,
    Key: key
  }).promise();


  const bytes = CryptoJS.AES.decrypt(
    obj.Body.toString(),
    FILE_SECRET
  );

  const buf = Buffer.from(
    bytes.toString(CryptoJS.enc.Utf8),
    "base64"
  );

  res.send(buf);
});


/* ================= PREVIEW ================= */

app.get("/preview", auth, async (req, res) => {

  const key = req.query.path;

  const obj = await s3.getObject({
    Bucket: BUCKET,
    Key: key
  }).promise();


  const bytes = CryptoJS.AES.decrypt(
    obj.Body.toString(),
    FILE_SECRET
  );

  const buf = Buffer.from(
    bytes.toString(CryptoJS.enc.Utf8),
    "base64"
  );


  const ext = path.extname(key).toLowerCase();

  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".pdf": "application/pdf",
    ".txt": "text/plain"
  };

  res.setHeader(
    "Content-Type",
    map[ext] || "application/octet-stream"
  );

  res.send(buf);
});


/* ================= DELETE ================= */

app.delete("/delete", auth, async (req, res) => {

  const key = req.query.path;

  await s3.deleteObject({
    Bucket: BUCKET,
    Key: key
  }).promise();

  res.json({ msg: "Deleted" });
});


/* ================= CHANGE PIN ================= */

app.post("/change-pin", auth, async (req, res) => {

  const { oldPin, newPin } = req.body;

  const obj = await s3.getObject({
  Bucket: BUCKET,
  Key: USER_KEY
}).promise();

const user = JSON.parse(obj.Body.toString());


  if (!bcrypt.compareSync(oldPin, user.pin))
    return res.status(401).json({ msg: "Wrong Old PIN" });

  const hash = bcrypt.hashSync(newPin, 10);

  await s3.putObject({
  Bucket: BUCKET,
  Key: USER_KEY,
  Body: JSON.stringify({ pin: hash }),
  ContentType:"application/json"
}).promise();

  res.json({ msg: "PIN Changed" });
});


/* ================= START ================= */

app.listen(3000, () => {
  console.log("🚀 Secure Vault running with S3");
});
