import { useState, useEffect, useCallback, useRef } from "react";
import { io } from "socket.io-client";

const BOARD_SIZE = 20;
const COLORS = ["#00cfff","#ff4466","#44ff88","#ffcc00"];
const COLOR_NAMES = ["Blue","Red","Green","Yellow"];
const COLOR_DARK = ["#007799","#991133","#117733","#886600"];

const THEMES = {
  tetris: { bg:"#0a0a1a", grid:"#1a1a3a", name:"TETRIS", accent:"#00cfff", panel:"#0d0d20", border:"#1a1a3a", font:"monospace", scanlines:false },
  tron:   { bg:"#000408", grid:"#001520", name:"TRON",   accent:"#00f0ff", panel:"#000c14", border:"#003344", font:"'Courier New', monospace", scanlines:true },
};

const PIECES_DEF = [
  [[0,0]],[[0,0],[1,0]],[[0,0],[1,0],[2,0]],[[0,0],[0,1],[1,1]],
  [[0,0],[1,0],[2,0],[3,0]],[[0,0],[1,0],[2,0],[0,1]],[[0,0],[1,0],[1,1],[2,1]],
  [[0,0],[0,1],[1,1],[1,2]],[[0,0],[1,0],[0,1],[1,1]],[[0,0],[1,0],[2,0],[3,0],[4,0]],
  [[0,0],[1,0],[2,0],[3,0],[0,1]],[[0,0],[1,0],[2,0],[0,1],[1,1]],
  [[0,0],[1,0],[1,1],[2,1],[2,2]],[[0,0],[0,1],[0,2],[1,2],[2,2]],
  [[0,0],[1,0],[2,0],[1,1],[1,2]],[[0,1],[1,0],[1,1],[1,2],[2,1]],
  [[0,0],[0,1],[1,1],[1,2],[2,2]],[[0,0],[1,0],[2,0],[0,1],[2,1]],
  [[0,0],[1,0],[1,1],[2,1],[1,2]],[[0,0],[0,1],[1,1],[2,1],[2,2]],
  [[0,0],[1,0],[0,1],[0,2],[1,2]],
];

const DEFAULT_KEYS = { rotate:"r", flip:"f", deselect:"Escape" };

function normalizePiece(cells) {
  const minR=Math.min(...cells.map(c=>c[0])), minC=Math.min(...cells.map(c=>c[1]));
  return cells.map(c=>[c[0]-minR,c[1]-minC]);
}
function rotatePiece(cells) { return normalizePiece(cells.map(([r,c])=>[c,-r])); }
function flipPiece(cells)   { return normalizePiece(cells.map(([r,c])=>[-r,c])); }
function pieceDimensions(cells) { return [Math.max(...cells.map(c=>c[0]))+1, Math.max(...cells.map(c=>c[1]))+1]; }

function initGame() {
  return {
    board: Array(BOARD_SIZE).fill(null).map(()=>Array(BOARD_SIZE).fill(-1)),
    pieces: COLORS.map(()=>PIECES_DEF.map((p,i)=>({id:i,cells:p,used:false}))),
    currentPlayer:0, firstMove:[true,true,true,true],
    selected:null, rotation:0, flipped:false, hover:null,
    gameOver:false, scores:[0,0,0,0], numPlayers:4,
    mode:"menu", aiPlayers:[], winner:null,
  };
}

function getTransformedCells(piece,rotation,flipped) {
  let cells=piece.cells.map(c=>[...c]);
  if(flipped) cells=flipPiece(cells);
  for(let i=0;i<rotation;i++) cells=rotatePiece(cells);
  return cells;
}
function getCellsAt(piece,rotation,flipped,row,col) {
  return getTransformedCells(piece,rotation,flipped).map(([r,c])=>[r+row,c+col]);
}
function canPlace(board,cells,player,firstMove) {
  let touchesCorner=false;
  for(const [r,c] of cells) {
    if(r<0||r>=BOARD_SIZE||c<0||c>=BOARD_SIZE) return false;
    if(board[r][c]!==-1) return false;
    for(const [dr,dc] of [[-1,0],[1,0],[0,-1],[0,1]])
      if(board[r+dr]?.[c+dc]===player) return false;
  }
  if(firstMove) {
    const sc=[[0,0],[0,BOARD_SIZE-1],[BOARD_SIZE-1,0],[BOARD_SIZE-1,BOARD_SIZE-1]];
    for(const [r,c] of cells) for(const [sr,scol] of sc) if(r===sr&&c===scol) touchesCorner=true;
  } else {
    for(const [r,c] of cells)
      for(const [dr,dc] of [[-1,-1],[-1,1],[1,-1],[1,1]])
        if(board[r+dr]?.[c+dc]===player) { touchesCorner=true; break; }
  }
  return touchesCorner;
}
function placePiece(board,cells,player) {
  const nb=board.map(r=>[...r]);
  for(const [r,c] of cells) nb[r][c]=player;
  return nb;
}
function calcScores(pieces) { return pieces.map(pp=>pp.filter(p=>!p.used).reduce((s,p)=>s+p.cells.length,0)); }
function checkHasMoves(board,pieces,player,firstMove) {
  for(const piece of pieces.filter(p=>!p.used))
    for(let f=0;f<2;f++) for(let r=0;r<4;r++) {
      let cells=piece.cells.map(c=>[...c]);
      if(f) cells=flipPiece(cells);
      for(let i=0;i<r;i++) cells=rotatePiece(cells);
      for(let row=0;row<BOARD_SIZE;row++) for(let col=0;col<BOARD_SIZE;col++)
        if(canPlace(board,cells.map(([cr,cc])=>[cr+row,cc+col]),player,firstMove)) return true;
    }
  return false;
}
function aiMove(board,pieces,player,firstMove,difficulty) {
  const myPieces=[...pieces[player].filter(p=>!p.used)]
    .sort((a,b)=>difficulty==="easy"?a.cells.length-b.cells.length:b.cells.length-a.cells.length);
  for(const piece of myPieces) {
    const positions=[];
    for(let f=0;f<2;f++) for(let r=0;r<4;r++) {
      let cells=piece.cells.map(c=>[...c]);
      if(f) cells=flipPiece(cells);
      for(let i=0;i<r;i++) cells=rotatePiece(cells);
      for(let row=0;row<BOARD_SIZE;row++) for(let col=0;col<BOARD_SIZE;col++) {
        const placed=cells.map(([cr,cc])=>[cr+row,cc+col]);
        if(canPlace(board,placed,player,firstMove)) positions.push({piece,cells:placed});
      }
    }
    if(positions.length>0) {
      if(difficulty==="hard") return positions.sort((a,b)=>b.cells.length-a.cells.length+Math.random()*2-1)[0];
      return positions[Math.floor(Math.random()*positions.length)];
    }
  }
  return null;
}
function advanceTurn(g) {
  const np=g.numPlayers;
  let next=(g.currentPlayer+1)%np, checked=0;
  while(checked<np) {
    if(checkHasMoves(g.board,g.pieces[next],next,g.firstMove[next])) break;
    next=(next+1)%np; checked++;
  }
  const scores=calcScores(g.pieces);
  if(checked>=np) {
    const min=Math.min(...scores.slice(0,np));
    return {...g,gameOver:true,scores,winner:scores.slice(0,np).indexOf(min),selected:null};
  }
  return {...g,currentPlayer:next,selected:null,rotation:0,flipped:false,hover:null,scores};
}

export default function CornerBlox() {
  const [game,setGame]=useState(initGame());
  const [difficulty,setDifficulty]=useState("medium");
  const [pvpCount,setPvpCount]=useState(2);
  const [theme,setTheme]=useState("tetris");
  const [keys,setKeys]=useState(DEFAULT_KEYS);
  const [binding,setBinding]=useState(null);
  const [showKeybinds,setShowKeybinds]=useState(false);
  // Online state
  const [socket,setSocket]=useState(null);
  const [roomCode,setRoomCode]=useState("");
  const [roomInput,setRoomInput]=useState("");
  const [onlineStatus,setOnlineStatus]=useState("");
  const [myPlayerIndex,setMyPlayerIndex]=useState(null);
  const [isOnline,setIsOnline]=useState(false);
  const aiTimerRef=useRef(null);
  const T=THEMES[theme];

  const handleAITurn=useCallback((g)=>{
    if(g.gameOver||!g.aiPlayers.includes(g.currentPlayer)) return;
    aiTimerRef.current=setTimeout(()=>{
      setGame(prev=>{
        if(prev.currentPlayer!==g.currentPlayer||prev.gameOver) return prev;
        const move=aiMove(prev.board,prev.pieces,prev.currentPlayer,prev.firstMove[prev.currentPlayer],difficulty);
        if(!move) return advanceTurn(prev);
        const newBoard=placePiece(prev.board,move.cells,prev.currentPlayer);
        const newPieces=prev.pieces.map((pp,pi)=>pi===prev.currentPlayer?pp.map(p=>p===move.piece?{...p,used:true}:p):pp);
        const newFirst=prev.firstMove.map((f,i)=>i===prev.currentPlayer?false:f);
        return advanceTurn({...prev,board:newBoard,pieces:newPieces,firstMove:newFirst});
      });
    },700);
  },[difficulty]);

  useEffect(()=>{ if(game.mode==="playing") handleAITurn(game); return()=>{if(aiTimerRef.current)clearTimeout(aiTimerRef.current);}; },[game.currentPlayer,game.mode,game.gameOver]);

  // Online socket setup
  useEffect(()=>{
    if(!isOnline) return;
    const s=io("http://localhost:3001");
    setSocket(s);
    s.on("room-joined",({room,playerIndex})=>{ setRoomCode(room); setMyPlayerIndex(playerIndex); setOnlineStatus(`Joined as ${COLOR_NAMES[playerIndex]}. Waiting for players...`); });
    s.on("game-start",({numPlayers})=>{ const ng=initGame(); ng.mode="playing"; ng.numPlayers=numPlayers; ng.aiPlayers=[]; setGame(ng); setOnlineStatus("Game started!"); });
    s.on("move-made",({board,pieces,firstMove,currentPlayer,scores,gameOver,winner})=>{
      setGame(prev=>({...prev,board,pieces,firstMove,currentPlayer,scores,gameOver,winner,selected:null,hover:null}));
    });
    s.on("player-left",()=>setOnlineStatus("A player left the game."));
    return()=>s.disconnect();
  },[isOnline]);

  useEffect(()=>{
    const handler=(e)=>{
      if(binding){ e.preventDefault(); setKeys(k=>({...k,[binding]:e.key})); setBinding(null); return; }
      if(game.mode!=="playing"||game.gameOver) return;
      if(isOnline&&myPlayerIndex!==game.currentPlayer) return;
      if(!isOnline&&game.aiPlayers.includes(game.currentPlayer)) return;
      if(e.key===keys.rotate) setGame(g=>({...g,rotation:(g.rotation+1)%4}));
      else if(e.key===keys.flip) setGame(g=>({...g,flipped:!g.flipped}));
      else if(e.key===keys.deselect) setGame(g=>({...g,selected:null,hover:null}));
    };
    window.addEventListener("keydown",handler);
    return()=>window.removeEventListener("keydown",handler);
  },[binding,game.mode,game.gameOver,game.currentPlayer,game.aiPlayers,keys,isOnline,myPlayerIndex]);

  function startGame(mode) {
    const ng=initGame(); ng.mode="playing"; ng.numPlayers=4;
    if(mode==="vsai") ng.aiPlayers=[1,2,3];
    else if(mode==="local"){ ng.aiPlayers=[]; ng.numPlayers=pvpCount; }
    else if(mode==="puzzle"){ ng.aiPlayers=[]; ng.numPlayers=1; }
    setGame(ng);
  }

  function joinRoom() {
    if(!socket||!roomInput.trim()) return;
    socket.emit("join-room",roomInput.trim().toUpperCase());
  }
  function createRoom() {
    if(!socket) return;
    const code=Math.random().toString(36).substring(2,6).toUpperCase();
    socket.emit("join-room",code);
  }

  function handleCellClick(row,col) {
    if(game.gameOver||game.selected===null) return;
    if(isOnline&&myPlayerIndex!==game.currentPlayer) return;
    if(!isOnline&&game.aiPlayers.includes(game.currentPlayer)) return;
    const piece=game.pieces[game.currentPlayer][game.selected];
    if(piece.used) return;
    const cells=getCellsAt(piece,game.rotation,game.flipped,row,col);
    if(!canPlace(game.board,cells,game.currentPlayer,game.firstMove[game.currentPlayer])) return;
    setGame(prev=>{
      const newBoard=placePiece(prev.board,cells,prev.currentPlayer);
      const newPieces=prev.pieces.map((pp,pi)=>pi===prev.currentPlayer?pp.map(p=>p.id===piece.id?{...p,used:true}:p):pp);
      const newFirst=prev.firstMove.map((f,i)=>i===prev.currentPlayer?false:f);
      const ng=advanceTurn({...prev,board:newBoard,pieces:newPieces,firstMove:newFirst});
      if(isOnline&&socket) socket.emit("make-move",{board:ng.board,pieces:ng.pieces,firstMove:ng.firstMove,currentPlayer:ng.currentPlayer,scores:ng.scores,gameOver:ng.gameOver,winner:ng.winner});
      return ng;
    });
  }

  function handleCellHover(row,col) {
    if(game.selected===null){ setGame(g=>({...g,hover:null})); return; }
    if(isOnline&&myPlayerIndex!==game.currentPlayer){ setGame(g=>({...g,hover:null})); return; }
    if(!isOnline&&game.aiPlayers.includes(game.currentPlayer)){ setGame(g=>({...g,hover:null})); return; }
    const piece=game.pieces[game.currentPlayer][game.selected];
    if(piece.used) return;
    const cells=getCellsAt(piece,game.rotation,game.flipped,row,col);
    const valid=canPlace(game.board,cells,game.currentPlayer,game.firstMove[game.currentPlayer]);
    setGame(g=>({...g,hover:{cells,valid}}));
  }

  const CELL=26;
  const scores=calcScores(game.pieces);
  const cp=game.currentPlayer;
  const isMyTurn=isOnline?myPlayerIndex===cp:!game.aiPlayers.includes(cp);
  const glow=(color,size=8)=>theme==="tron"?`0 0 ${size}px ${color}, 0 0 ${size*2}px ${color}44`:"none";
  const keyLabel=(k)=>k==="Escape"?"ESC":k===" "?"SPC":k.toUpperCase();

  // MENU
  if(game.mode==="menu") return (
    <div style={{background:T.bg,minHeight:"600px",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:T.font,padding:"2rem",position:"relative"}}>
      {T.scanlines&&<div style={{position:"fixed",top:0,left:0,right:0,bottom:0,backgroundImage:"repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,240,255,0.015) 2px,rgba(0,240,255,0.015) 4px)",pointerEvents:"none",zIndex:10}}/>}

      <div style={{position:"absolute",top:"12px",right:"12px",display:"flex",gap:"6px"}}>
        {Object.keys(THEMES).map(t=>(
          <button key={t} onClick={()=>setTheme(t)} style={{padding:"4px 10px",background:theme===t?T.accent+"22":"transparent",border:`1px solid ${theme===t?T.accent:"#333"}`,color:theme===t?T.accent:"#555",cursor:"pointer",fontFamily:T.font,fontSize:"10px",letterSpacing:"1px"}}>{THEMES[t].name}</button>
        ))}
      </div>

      <button onClick={()=>setShowKeybinds(!showKeybinds)} style={{position:"absolute",top:"12px",left:"12px",padding:"4px 10px",background:"transparent",border:"1px solid #333",color:"#555",cursor:"pointer",fontFamily:T.font,fontSize:"10px",letterSpacing:"1px"}}>KEYS</button>
      {showKeybinds&&(
        <div style={{position:"absolute",top:"44px",left:"12px",background:T.panel,border:`1px solid ${T.accent}`,padding:"12px",zIndex:20,minWidth:"200px"}}>
          <div style={{fontSize:"11px",color:T.accent,letterSpacing:"2px",marginBottom:"8px"}}>KEYBINDS</div>
          {[["rotate","ROTATE"],["flip","FLIP"],["deselect","DESELECT"]].map(([k,label])=>(
            <div key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"6px",gap:"12px"}}>
              <span style={{fontSize:"11px",color:"#888"}}>{label}</span>
              <button onClick={()=>setBinding(binding===k?null:k)} style={{padding:"2px 10px",background:binding===k?"#ff446622":"transparent",border:`1px solid ${binding===k?"#ff4466":T.border}`,color:binding===k?"#ff4466":COLORS[0],cursor:"pointer",fontFamily:T.font,fontSize:"11px",minWidth:"50px"}}>
                {binding===k?"PRESS...":keyLabel(keys[k])}
              </button>
            </div>
          ))}
          <button onClick={()=>{setKeys(DEFAULT_KEYS);setBinding(null);}} style={{marginTop:"6px",width:"100%",padding:"3px",background:"transparent",border:"1px solid #333",color:"#555",cursor:"pointer",fontFamily:T.font,fontSize:"10px"}}>RESET DEFAULTS</button>
        </div>
      )}

      <div style={{textAlign:"center",marginBottom:"2rem"}}>
        {theme==="tron"?(
          <>
            <div style={{fontSize:"2.8rem",fontWeight:"bold",letterSpacing:"8px",color:T.accent,textShadow:glow(T.accent,12),borderTop:`2px solid ${T.accent}`,borderBottom:`2px solid ${T.accent}`,padding:"8px 16px"}}>CORNER BLOX</div>
            <div style={{fontSize:"0.7rem",color:T.accent+"88",letterSpacing:"4px",marginTop:"8px"}}>GRID WARFARE PROTOCOL</div>
          </>
        ):(
          <>
            <div style={{fontSize:"3rem",fontWeight:"bold",letterSpacing:"4px",color:"#00cfff"}}>CORNER</div>
            <div style={{fontSize:"3rem",fontWeight:"bold",letterSpacing:"4px",color:"#ff4466"}}>BLOX</div>
            <div style={{fontSize:"0.75rem",color:"#666",letterSpacing:"2px",marginTop:"4px"}}>PIXEL STRATEGY</div>
          </>
        )}
      </div>

      <div style={{display:"flex",flexDirection:"column",gap:"12px",width:"260px"}}>
        {[{label:"VS AI",sub:`1 human vs 3 AI · ${difficulty}`,mode:"vsai"},{label:"LOCAL PLAY",sub:`${pvpCount} players hot-seat`,mode:"local"},{label:"PUZZLE",sub:"solo challenge",mode:"puzzle"}].map((btn,bi)=>(
          <div key={btn.mode}>
            {btn.mode==="local"&&(<div style={{display:"flex",gap:"6px",marginBottom:"6px",justifyContent:"center"}}>{[2,3,4].map(n=>(<button key={n} onClick={()=>setPvpCount(n)} style={{padding:"4px 12px",background:pvpCount===n?COLORS[0]+"22":"transparent",border:`1px solid ${pvpCount===n?COLORS[0]:"#333"}`,color:pvpCount===n?COLORS[0]:"#888",cursor:"pointer",fontSize:"12px",fontFamily:T.font}}>{n}P</button>))}</div>)}
            {btn.mode==="vsai"&&(<div style={{display:"flex",gap:"6px",marginBottom:"6px",justifyContent:"center"}}>{["easy","medium","hard"].map(d=>(<button key={d} onClick={()=>setDifficulty(d)} style={{padding:"4px 10px",background:difficulty===d?"#ff446622":"transparent",border:`1px solid ${difficulty===d?"#ff4466":"#333"}`,color:difficulty===d?"#ff4466":"#888",cursor:"pointer",fontSize:"11px",fontFamily:T.font,textTransform:"uppercase"}}>{d}</button>))}</div>)}
            <button onClick={()=>startGame(btn.mode)} style={{width:"100%",padding:"14px",background:"transparent",border:`1px solid ${COLORS[bi]}`,color:COLORS[bi],cursor:"pointer",fontFamily:T.font,fontSize:"14px",letterSpacing:"2px"}}
              onMouseEnter={e=>e.currentTarget.style.background=COLORS[bi]+"22"}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              {btn.label}<div style={{fontSize:"10px",opacity:0.6,marginTop:"2px"}}>{btn.sub}</div>
            </button>
          </div>
        ))}

        {/* Online section */}
        <div style={{border:`1px solid ${COLORS[3]}`,padding:"12px"}}>
          <div style={{color:COLORS[3],fontSize:"13px",letterSpacing:"2px",marginBottom:"8px"}}>ONLINE</div>
          {!isOnline?(
            <button onClick={()=>setIsOnline(true)} style={{width:"100%",padding:"8px",background:"transparent",border:`1px solid ${COLORS[3]}44`,color:COLORS[3],cursor:"pointer",fontFamily:T.font,fontSize:"12px"}}>CONNECT TO SERVER</button>
          ):(
            <>
              <div style={{fontSize:"10px",color:"#555",marginBottom:"6px"}}>{onlineStatus||"Connected"}</div>
              {roomCode?(
                <div style={{textAlign:"center"}}>
                  <div style={{fontSize:"10px",color:"#888",marginBottom:"4px"}}>ROOM CODE</div>
                  <div style={{fontSize:"24px",letterSpacing:"6px",color:COLORS[3],fontWeight:"bold"}}>{roomCode}</div>
                  <div style={{fontSize:"10px",color:"#555",marginTop:"4px"}}>Share this with your friend!</div>
                </div>
              ):(
                <>
                  <button onClick={createRoom} style={{width:"100%",padding:"8px",background:"transparent",border:`1px solid ${COLORS[3]}`,color:COLORS[3],cursor:"pointer",fontFamily:T.font,fontSize:"12px",marginBottom:"6px"}}>CREATE ROOM</button>
                  <div style={{display:"flex",gap:"6px"}}>
                    <input value={roomInput} onChange={e=>setRoomInput(e.target.value.toUpperCase())} placeholder="ROOM CODE" maxLength={4} style={{flex:1,padding:"6px",background:"transparent",border:`1px solid #333`,color:"#ccc",fontFamily:T.font,fontSize:"12px",letterSpacing:"2px",textAlign:"center"}}/>
                    <button onClick={joinRoom} style={{padding:"6px 10px",background:"transparent",border:`1px solid ${COLORS[3]}`,color:COLORS[3],cursor:"pointer",fontFamily:T.font,fontSize:"11px"}}>JOIN</button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
      <div style={{marginTop:"1.5rem",fontSize:"11px",color:"#444",textAlign:"center",lineHeight:"1.8"}}>Place pieces touching only your own corners · Fewest squares left wins</div>
    </div>
  );

  // GAME BOARD
  return (
    <div style={{background:T.bg,minHeight:"600px",display:"flex",flexDirection:"column",fontFamily:T.font,color:"#ccc",overflow:"auto",position:"relative"}}>
      {T.scanlines&&<div style={{position:"fixed",top:0,left:0,right:0,bottom:0,backgroundImage:"repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,240,255,0.015) 2px,rgba(0,240,255,0.015) 4px)",pointerEvents:"none",zIndex:10}}/>}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 16px",borderBottom:`1px solid ${T.border}`}}>
        <button onClick={()=>setGame(initGame())} style={{background:"transparent",border:`1px solid ${T.border}`,color:"#888",cursor:"pointer",fontFamily:T.font,padding:"4px 10px",fontSize:"11px"}}>MENU</button>
        <div style={{fontSize:"14px",letterSpacing:"4px",color:T.accent,textShadow:glow(T.accent,6)}}>CORNERBLOX</div>
        <div style={{display:"flex",gap:"6px",alignItems:"center"}}>
          {isOnline&&roomCode&&<div style={{fontSize:"11px",color:COLORS[3],letterSpacing:"2px"}}>#{roomCode}</div>}
          {Object.keys(THEMES).map(t=>(<button key={t} onClick={()=>setTheme(t)} style={{padding:"2px 6px",background:theme===t?T.accent+"22":"transparent",border:`1px solid ${theme===t?T.accent:"#333"}`,color:theme===t?T.accent:"#555",cursor:"pointer",fontFamily:T.font,fontSize:"9px"}}>{THEMES[t].name}</button>))}
        </div>
      </div>

      <div style={{display:"flex",gap:"8px",padding:"8px 16px",justifyContent:"center",flexWrap:"wrap"}}>
        {Array(game.numPlayers).fill(0).map((_,i)=>(
          <div key={i} style={{padding:"4px 12px",border:`${i===cp&&!game.gameOver?"2":"1"}px solid ${i===cp&&!game.gameOver?COLORS[i]:"#333"}`,color:COLORS[i],fontSize:"11px",textAlign:"center",background:i===cp&&!game.gameOver?COLORS[i]+"11":"transparent",boxShadow:i===cp&&!game.gameOver&&theme==="tron"?glow(COLORS[i],6):"none",transition:"all 0.3s"}}>
            <div style={{letterSpacing:"1px"}}>{COLOR_NAMES[i]}{!isOnline&&game.aiPlayers.includes(i)?" AI":""}{isOnline&&i===myPlayerIndex?" (YOU)":""}</div>
            <div style={{fontSize:"16px",fontWeight:"bold"}}>{scores[i]}</div>
          </div>
        ))}
      </div>

      {game.gameOver&&(
        <div style={{textAlign:"center",padding:"8px",background:T.panel,borderTop:`1px solid ${T.border}`,borderBottom:`1px solid ${T.border}`}}>
          <span style={{color:COLORS[game.winner],fontSize:"14px",letterSpacing:"2px",textShadow:theme==="tron"?glow(COLORS[game.winner],8):"none"}}>{COLOR_NAMES[game.winner]} WINS!</span>
          <button onClick={()=>setGame(initGame())} style={{marginLeft:"16px",background:"transparent",border:"1px solid #555",color:"#aaa",cursor:"pointer",fontFamily:T.font,padding:"2px 10px",fontSize:"11px"}}>PLAY AGAIN</button>
        </div>
      )}

      <div style={{display:"flex",flex:1,overflow:"auto"}}>
        <div style={{padding:"12px",overflow:"auto",flex:"0 0 auto"}}>
          <div style={{display:"grid",gridTemplateColumns:`repeat(${BOARD_SIZE},${CELL}px)`,gap:"1px",background:T.grid,border:`1px solid ${T.border}`}} onMouseLeave={()=>setGame(g=>({...g,hover:null}))}>
            {Array(BOARD_SIZE).fill(0).map((_,row)=>Array(BOARD_SIZE).fill(0).map((__,col)=>{
              const owner=game.board[row][col];
              const hCell=game.hover?.cells?.some(([r,c])=>r===row&&c===col);
              const hValid=game.hover?.valid;
              let bg=T.panel, boxShadow="none";
              if(owner>=0){ bg=COLORS[owner]; if(theme==="tron") boxShadow=`inset 0 0 4px ${COLORS[owner]}, 0 0 4px ${COLORS[owner]}88`; }
              else if(hCell){ bg=hValid?COLORS[cp]+(theme==="tron"?"cc":"99"):"#ff444444"; if(theme==="tron"&&hValid) boxShadow=`0 0 6px ${COLORS[cp]}`; }
              return <div key={`${row}-${col}`} style={{width:CELL,height:CELL,background:bg,cursor:game.selected!==null&&isMyTurn?"crosshair":"default",transition:"background 0.05s",boxSizing:"border-box",border:owner>=0?`1px solid ${theme==="tron"?COLORS[owner]:COLOR_DARK[owner]}`:"none",boxShadow}} onClick={()=>handleCellClick(row,col)} onMouseEnter={()=>handleCellHover(row,col)}/>;
            }))}
          </div>
        </div>

        <div style={{flex:1,padding:"12px",overflowY:"auto",minWidth:"150px",maxWidth:"190px"}}>
          {!game.gameOver&&(
            <>
              <div style={{fontSize:"11px",color:COLORS[cp],letterSpacing:"1px",marginBottom:"6px",textShadow:theme==="tron"?glow(COLORS[cp],4):"none"}}>
                {isOnline?(myPlayerIndex===cp?"YOUR TURN":"WAITING..."):(game.aiPlayers.includes(cp)?"AI THINKING...":"YOUR TURN")}
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:"4px",marginBottom:"8px"}}>
                {[["rotate","ROT",keys.rotate],["flip","FLIP",keys.flip],["deselect","CLR",keys.deselect]].map(([action,label,key])=>(
                  <button key={action} onClick={()=>{
                    if(action==="rotate") setGame(g=>({...g,rotation:(g.rotation+1)%4}));
                    else if(action==="flip") setGame(g=>({...g,flipped:!g.flipped}));
                    else setGame(g=>({...g,selected:null,hover:null}));
                  }} style={{padding:"5px 6px",background:"transparent",border:`1px solid ${T.border}`,color:"#aaa",cursor:"pointer",fontFamily:T.font,fontSize:"10px",display:"flex",justifyContent:"space-between",alignItems:"center",letterSpacing:"1px"}}>
                    <span>{label}</span>
                    <span style={{color:T.accent,fontSize:"9px",background:T.bg,padding:"1px 4px",border:`1px solid ${T.border}`}}>{keyLabel(key)}</span>
                  </button>
                ))}
              </div>
              <div style={{marginBottom:"8px",padding:"6px",border:`1px solid ${T.border}`,background:T.panel}}>
                <div style={{fontSize:"9px",color:"#555",letterSpacing:"1px",marginBottom:"4px"}}>REMAP KEYS</div>
                {[["rotate","ROT"],["flip","FLP"],["deselect","CLR"]].map(([k,short])=>(
                  <div key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"3px"}}>
                    <span style={{fontSize:"9px",color:"#666"}}>{short}</span>
                    <button onClick={()=>setBinding(binding===k?null:k)} style={{padding:"1px 6px",background:binding===k?"#ff446622":"transparent",border:`1px solid ${binding===k?"#ff4466":T.border}`,color:binding===k?"#ff4466":T.accent,cursor:"pointer",fontFamily:T.font,fontSize:"9px"}}>
                      {binding===k?"...":keyLabel(keys[k])}
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
          <div style={{fontSize:"10px",color:"#555",marginBottom:"6px",letterSpacing:"1px"}}>PIECES</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px"}}>
            {game.pieces[cp].map((piece,i)=>{
              const cells=getTransformedCells(piece,i===game.selected?game.rotation:0,i===game.selected?game.flipped:false);
              const [rows,cols]=pieceDimensions(cells);
              const SZ=8, isSel=game.selected===i;
              return (
                <div key={i} onClick={()=>!piece.used&&isMyTurn&&!game.gameOver&&setGame(g=>({...g,selected:i,rotation:0,flipped:false}))}
                  style={{padding:"4px",border:`1px solid ${isSel?COLORS[cp]:piece.used?"#111":T.border}`,background:isSel?COLORS[cp]+"22":"transparent",cursor:piece.used?"default":"pointer",opacity:piece.used?0.15:1,minHeight:"38px",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:isSel&&theme==="tron"?glow(COLORS[cp],6):"none"}}>
                  <div style={{display:"grid",gridTemplateColumns:`repeat(${cols},${SZ}px)`,gap:"1px"}}>
                    {Array(rows).fill(0).map((_,r)=>Array(cols).fill(0).map((__,c)=>{
                      const has=cells.some(([cr,cc])=>cr===r&&cc===c);
                      return <div key={`${r}-${c}`} style={{width:SZ,height:SZ,background:has?COLORS[cp]:"transparent",border:has?`0.5px solid ${theme==="tron"?COLORS[cp]:COLOR_DARK[cp]}`:"none",boxShadow:has&&theme==="tron"?`0 0 3px ${COLORS[cp]}`:"none"}}/>;
                    }))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}