require("dotenv").config();
// Remove empty parent folders
function cleanEmptyDirs(dir){

  if(dir === DATA_DIR) return;

  if(!fs.existsSync(dir)) return;

  if(fs.readdirSync(dir).length === 0){

    fs.rmdirSync(dir);

    cleanEmptyDirs(path.dirname(dir));
  }
}

const express = require("express");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const CryptoJS = require("crypto-js");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));


const DATA_DIR = "vault_data";
const USER_FILE = "user.json";

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// Storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, DATA_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "_" + file.originalname);
  },
});

const upload = multer({ storage });

// Init user
if (!fs.existsSync(USER_FILE)) {
  const hash = bcrypt.hashSync("1234", 10); // DEFAULT PIN
  fs.writeFileSync(
    USER_FILE,
    JSON.stringify({ pin: hash }, null, 2)
  );
}

// Login
app.post("/login", (req, res) => {
  const { pin } = req.body;

  const user = JSON.parse(fs.readFileSync(USER_FILE));

  if (!bcrypt.compareSync(pin, user.pin))
    return res.status(401).json({ msg: "Wrong PIN" });

  const token = jwt.sign(
    { user: "me" },
    "SECRETKEY",
    { expiresIn: "2h" }
  );

  res.json({ token });
});

// Auth middleware
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.sendStatus(403);

  try {
    jwt.verify(h, "SECRETKEY");
    next();
  } catch {
    res.sendStatus(403);
  }
}

// Upload
// Upload with folders
app.post("/upload", auth, upload.single("file"), (req, res) => {

  const relPath = req.body.path || req.file.originalname;

  const savePath = path.join(DATA_DIR, relPath);

  // Create folders if needed
  fs.mkdirSync(path.dirname(savePath), { recursive:true });

  const data = fs.readFileSync(req.file.path);

  const encrypted = CryptoJS.AES.encrypt(
    data.toString("base64"),
    "FILE_SECRET"
  ).toString();

  fs.writeFileSync(savePath, encrypted);

  fs.unlinkSync(req.file.path);

  res.json({ msg:"Uploaded & Encrypted" });
});


// List files
// List files & folders
app.get("/files", auth, (req, res) => {

  const dir = req.query.path || "";

  const fullPath = path.join(DATA_DIR, dir);

  if(!fs.existsSync(fullPath)){
    return res.json([]);
  }

  const items = fs.readdirSync(fullPath, { withFileTypes:true });

  const result = items.map(i=>({
    name: i.name,
    isDir: i.isDirectory()
  }));

  res.json(result);
});


// Download
// Download file
app.get("/download", auth, (req, res) => {

  const filePath = req.query.path;

  if(!filePath) return res.sendStatus(400);

  const full = path.join(DATA_DIR, filePath);

  if(!fs.existsSync(full)) return res.sendStatus(404);

  if(fs.statSync(full).isDirectory()){
    return res.status(400).json({ msg:"Folder" });
  }

  const enc = fs.readFileSync(full, "utf8");

  const bytes = CryptoJS.AES.decrypt(enc, "FILE_SECRET");

  const data = Buffer.from(
    bytes.toString(CryptoJS.enc.Utf8),
    "base64"
  );

  res.send(data);
});

// Change PIN
app.post("/change-pin", auth, (req,res)=>{

  const { oldPin, newPin } = req.body;

  const user = JSON.parse(fs.readFileSync(USER_FILE));

  if(!bcrypt.compareSync(oldPin, user.pin)){
    return res.status(401).json({ msg:"Wrong Old PIN" });
  }

  const hash = bcrypt.hashSync(newPin,10);

  fs.writeFileSync(
    USER_FILE,
    JSON.stringify({ pin: hash }, null, 2)
  );

  res.json({ msg:"PIN Changed" });
});
// Preview file
app.get("/preview", auth, (req,res)=>{

  const p = req.query.path;

  if(!p) return res.sendStatus(400);

  const full = path.join(DATA_DIR,p);

  if(!fs.existsSync(full)) return res.sendStatus(404);

  if(fs.statSync(full).isDirectory()){
    return res.sendStatus(400);
  }

  const enc = fs.readFileSync(full,"utf8");

  const bytes = CryptoJS.AES.decrypt(enc,"FILE_SECRET");

  const buf = Buffer.from(
    bytes.toString(CryptoJS.enc.Utf8),
    "base64"
  );

  // Detect type
  const ext = path.extname(p).toLowerCase();

  const map = {
    ".jpg":"image/jpeg",
    ".jpeg":"image/jpeg",
    ".png":"image/png",
    ".pdf":"application/pdf",
    ".txt":"text/plain"
  };

  res.setHeader(
    "Content-Type",
    map[ext] || "application/octet-stream"
  );

  res.send(buf);
});

// Delete file/folder
app.delete("/delete", auth, (req,res)=>{

  const p = req.query.path;

  if(!p) return res.sendStatus(400);

  const full = path.join(DATA_DIR, p);

  if(!fs.existsSync(full)) return res.sendStatus(404);

fs.rmSync(full, { recursive:true, force:true });

cleanEmptyDirs(path.dirname(full));


  res.json({ msg:"Deleted" });
});
// Rename / Move (auto-create folders)
app.post("/rename", auth, (req,res)=>{

  const { oldPath, newName } = req.body;

  if(!oldPath || !newName)
    return res.status(400).json({msg:"Invalid data"});

  const oldFull = path.join(DATA_DIR, oldPath);

  if(!fs.existsSync(oldFull))
    return res.status(404).json({msg:"Not found"});

  const newFull = path.join(DATA_DIR, newName);

  // Create target folders if missing
  fs.mkdirSync(path.dirname(newFull), { recursive:true });

  fs.renameSync(oldFull, newFull);

  res.json({ msg:"Done" });
});


// File / Folder Info
app.get("/info", auth, (req,res)=>{

  const p = req.query.path;

  if(!p) return res.sendStatus(400);

  const full = path.join(DATA_DIR,p);

  if(!fs.existsSync(full))
    return res.sendStatus(404);

  const stat = fs.statSync(full);

  res.json({
    name: path.basename(p),
    type: stat.isDirectory() ? "Folder" : "File",
    size: stat.size,
    created: stat.birthtime
  });
});
// Empty recycle bin
app.delete("/empty-trash", auth, (req,res)=>{

  const trash = path.join(DATA_DIR, "__trash__");

  if(fs.existsSync(trash)){
    fs.rmSync(trash, { recursive:true, force:true });
  }

  res.json({ msg:"Trash cleared" });
});

app.listen(3000, () => {
  console.log("🚀 Server running on http://localhost:3000");
});
