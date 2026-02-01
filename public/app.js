let token = "";
let currentPath = "";
let selected = new Set();
let allItems = [];
let isDark = true;
let ctxTarget = "";



/* ================= LOGIN ================= */

async function login(){

  const pin = document.getElementById("pin").value;

  const res = await fetch("http://localhost:3000/login",{
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ pin })
  });

  if(!res.ok){
    document.getElementById("msg").innerText="❌ Wrong PIN";
    return;
  }

  const data = await res.json();
  token = data.token;

  document.getElementById("loginBox").style.display="none";
  document.getElementById("app").style.display="flex";

  loadFiles();
}


function logout(){
  location.reload();
}


/* ================= THEME ================= */

function toggleTheme(){

  const body = document.body;

  if(isDark){
    body.classList.remove("dark");
    body.classList.add("light");
  }else{
    body.classList.remove("light");
    body.classList.add("dark");
  }

  isDark = !isDark;
}


/* ================= NAV ================= */

function goHome(){
  loadFiles("");
}

function openTrash(){
  loadFiles("__trash__");
}


/* ================= LOAD FILES ================= */

async function loadFiles(path=""){

  currentPath = path;
  selected.clear();
  updateActions();

  document.getElementById("path").innerText =
    path || "Home";

  const res = await fetch(
    `http://localhost:3000/files?path=${path}`,
    { headers:{ Authorization:token } }
  );

  allItems = await res.json();

  renderFiles(allItems);
}


/* ================= RENDER ================= */

function renderFiles(items){

  const body = document.getElementById("files");
  body.innerHTML="";


  /* If Empty Folder */

  if(items.length === 0){

    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td colspan="4" style="text-align:center; padding:30px; color:gray;">
        📂 No folders or files
      </td>
    `;

    body.appendChild(tr);
    return;
  }


  /* Back Button */

  if(currentPath){

    const tr=document.createElement("tr");

    tr.innerHTML=`
      <td></td>
      <td>⬅ Back</td>
      <td>Folder</td>
      <td></td>
    `;

    tr.onclick=()=>{
      const p=currentPath.split("/").slice(0,-1).join("/");
      loadFiles(p);
    };

    body.appendChild(tr);
  }


  /* Items */

  items.forEach(i=>{

    const tr=document.createElement("tr");
   tr.oncontextmenu = (e)=>{
   e.preventDefault();
   showMenu(e.pageX,e.pageY,id);
  };
    const id = (currentPath?currentPath+"/":"")+i.name;


    /* Checkbox */

    const check=document.createElement("input");
    check.type="checkbox";

    check.onchange=()=>{

      if(check.checked) selected.add(id);
      else selected.delete(id);

      updateActions();
    };

    const tdCheck=document.createElement("td");
    tdCheck.appendChild(check);


    /* Name */

    const tdName=document.createElement("td");
    tdName.innerText=(i.isDir?"📁 ":"📄 ")+i.name;
    tdName.style.cursor="pointer";


    /* Type */

    const tdType=document.createElement("td");
    tdType.innerText=i.isDir?"Folder":"File";


    /* Actions */

    const tdAct=document.createElement("td");


    if(i.isDir){

      tdName.onclick=()=>{
        loadFiles(id);
      };

    }else{

      const view=document.createElement("button");
      view.innerText="View";
      view.className="btn view";
      view.onclick=()=>preview(currentPath,i.name);

      const down=document.createElement("button");
      down.innerText="Down";
      down.className="btn down";
      down.onclick=()=>download(currentPath,i.name);

      tdAct.append(view,down);
    }


    tr.append(tdCheck,tdName,tdType,tdAct);

    body.appendChild(tr);
  });
}



/* ================= SEARCH ================= */

function filterFiles(){

  const q=document.getElementById("search").value.toLowerCase();

  const filtered = allItems.filter(i=>
    i.name.toLowerCase().includes(q)
  );

  renderFiles(filtered);
}


/* ================= UPLOAD ================= */

async function uploadFiles(){

  const files=document.getElementById("fileInput").files;

  for(let f of files){

    const fd=new FormData();

    fd.append("file",f);

    if(currentPath)
      fd.append("path",currentPath+"/"+f.name);

    await fetch("http://localhost:3000/upload",{
      method:"POST",
      headers:{Authorization:token},
      body:fd
    });
  }

  loadFiles(currentPath);
}


async function uploadFolders(){

  const files=document.getElementById("folderInput").files;

  for(let f of files){

    const fd=new FormData();

    let p = f.webkitRelativePath;

    if(currentPath)
      p = currentPath+"/"+p;

    fd.append("file",f);
    fd.append("path",p);

    await fetch("http://localhost:3000/upload",{
      method:"POST",
      headers:{Authorization:token},
      body:fd
    });
  }

  loadFiles(currentPath);
}


/* ================= ACTION BAR ================= */

function updateActions(){

  const bar=document.getElementById("actions");
  bar.innerHTML="";

  const count=selected.size;

  if(count===0) return;


  const info=document.createElement("span");
  info.innerText=count+" selected ";
  info.style.marginRight="10px";

  bar.appendChild(info);


  if(count===1){

    const move=document.createElement("button");
    move.innerText="Move";
    move.className="btn move";
    move.onclick=moveItem;

    const rename=document.createElement("button");
    rename.innerText="Rename";
    rename.className="btn rename";   // ✅ FIX
    rename.onclick=renameItem;

    const infoBtn=document.createElement("button");
    infoBtn.innerText="Info";
    infoBtn.className="btn info";    // ✅ FIX
    infoBtn.onclick=showInfo;

    bar.append(move,rename,infoBtn);
  }


  const del=document.createElement("button");
  del.innerText="Delete";
  del.className="btn del";
  del.onclick=deleteSelected;

  bar.appendChild(del);
}



/* ================= PREVIEW ================= */

async function preview(path,name){

  const p=path?path+"/"+name:name;

  const res=await fetch(
    `http://localhost:3000/preview?path=${p}`,
    { headers:{Authorization:token} }
  );

  const blob=await res.blob();

  window.open(URL.createObjectURL(blob));
}


/* ================= DOWNLOAD ================= */

async function download(path,name){

  const p=path?path+"/"+name:name;

  const res=await fetch(
    `http://localhost:3000/download?path=${p}`,
    { headers:{Authorization:token} }
  );

  const blob=await res.blob();

  const url=URL.createObjectURL(blob);

  const a=document.createElement("a");
  a.href=url;
  a.download=name;
  a.click();
}


/* ================= DELETE (RECYCLE) ================= */

async function deleteSelected(){

  if(!confirm("Move to Recycle Bin?")) return;

  for(let p of selected){

    const name=p.split("/").pop();

    await fetch("http://localhost:3000/rename",{
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        Authorization:token
      },
      body:JSON.stringify({
        oldPath:p,
        newName:"__trash__/"+name
      })
    });
  }

  selected.clear();
  loadFiles(currentPath);
}


/* ================= MOVE ================= */

async function moveItem(){

  const oldPath=[...selected][0];

  const target=prompt("Move to folder path:");

  if(!target) return;

  const name=oldPath.split("/").pop();

  await fetch("http://localhost:3000/rename",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      Authorization:token
    },
    body:JSON.stringify({
      oldPath,
      newName:target+"/"+name
    })
  });

  selected.clear();
  loadFiles(currentPath);
}


/* ================= RENAME ================= */

async function renameItem(){

  const oldPath=[...selected][0];

  const name=prompt("New name:");

  if(!name) return;

  await fetch("http://localhost:3000/rename",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      Authorization:token
    },
    body:JSON.stringify({
      oldPath,
      newName:name
    })
  });

  selected.clear();
  loadFiles(currentPath);
}


/* ================= INFO ================= */

async function showInfo(){

  const p=[...selected][0];

  const res=await fetch(
    `http://localhost:3000/info?path=${p}`,
    { headers:{Authorization:token} }
  );

  const d=await res.json();

  alert(`
Name: ${d.name}
Type: ${d.type}
Size: ${d.size} bytes
Created: ${d.created}
`);
}


/* ================= PROFILE ================= */

function openProfile(){
  document.getElementById("profile").style.display="flex";
}

function closeProfile(){
  document.getElementById("profile").style.display="none";
}


async function changePin(){

  const oldPin=document.getElementById("oldPin").value;
  const newPin=document.getElementById("newPin").value;

  const res=await fetch("http://localhost:3000/change-pin",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      Authorization:token
    },
    body:JSON.stringify({oldPin,newPin})
  });

  const d=await res.json();

  document.getElementById("pinMsg").innerText=d.msg;
}
// Empty recycle bin
async function emptyTrash(){

  if(!confirm("Delete ALL files permanently?")) return;

  await fetch("http://localhost:3000/empty-trash",{
    method:"DELETE",
    headers:{ Authorization:token }
  });

  loadFiles("__trash__");
}
/* ================= DRAG & DROP ================= */

const dropArea = document.getElementById("dropArea");

["dragenter","dragover"].forEach(e=>{

  document.addEventListener(e,(ev)=>{
    ev.preventDefault();
    dropArea.classList.add("drag");
  });
});

["dragleave","drop"].forEach(e=>{

  document.addEventListener(e,(ev)=>{
    ev.preventDefault();
    dropArea.classList.remove("drag");
  });
});


document.addEventListener("drop", async (e)=>{

  e.preventDefault();

  const files = e.dataTransfer.files;

  for(let f of files){

    const fd = new FormData();

    fd.append("file",f);

    let path = currentPath
      ? currentPath+"/"+f.name
      : f.name;

    fd.append("path",path);

    await fetch("http://localhost:3000/upload",{
      method:"POST",
      headers:{Authorization:token},
      body:fd
    });
  }

  loadFiles(currentPath);
});
/* ================= RIGHT CLICK MENU ================= */

const menu = document.getElementById("menu");

document.addEventListener("click",()=>{
  menu.style.display="none";
});


function showMenu(x,y,path){

  ctxTarget = path;

  menu.style.left = x+"px";
  menu.style.top = y+"px";
  menu.style.display="block";
}


/* Menu actions */

function ctxOpen(){

  menu.style.display="none";

  if(ctxTarget.includes(".")){
    preview(
      currentPath,
      ctxTarget.split("/").pop()
    );
  }else{
    loadFiles(ctxTarget);
  }
}


function ctxRename(){
  menu.style.display="none";
  selected.clear();
  selected.add(ctxTarget);
  renameItem();
}


function ctxMove(){
  menu.style.display="none";
  selected.clear();
  selected.add(ctxTarget);
  moveItem();
}


function ctxDelete(){
  menu.style.display="none";
  selected.clear();
  selected.add(ctxTarget);
  deleteSelected();
}

