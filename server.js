const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.static('public'));

// ========== Game Constants ==========
const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const WANTAIN_LIMIT = 9000;
const MAX_ROUNDS = 3;

// ========== Game State ==========
let players = {};
// ခုံတွေကို Number key အဖြစ်သေချာသတ်မှတ်မယ်
let seats = { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null };
let deck = [];
let gameState = {
  status: 'waiting',
  bankerId: null, // ၎င်းသည် Seat Number ဖြစ်သည်
  bankerFund: 3000,
  bankerRoundCount: 0,
  isWantainStarted: false,
  currentTurn: null,
  playerBets: {},
  playerHands: {},
  winners: []
};

// ========== Logic Functions ==========
function createDeck() {
  let d = [];
  for (let s of SUITS) {
    for (let v of VALUES) {
      d.push({ v, s, c: (s === '♥' || s === '♦') ? 'red' : 'black' });
    }
  }
  return d.sort(() => Math.random() - 0.5);
}

function getScore(hand) {
  if (!hand || hand.length === 0) return 0;
  let total = 0;
  hand.forEach(c => {
    if (['J', 'Q', 'K', '10'].includes(c.v)) total += 0;
    else if (c.v === 'A') total += 1;
    else total += parseInt(c.v);
  });
  return total % 10;
}

function isPoke(hand) {
  return hand && hand.length === 2 && getScore(hand) >= 8;
}

function compareHands(pSeat, bSeat) {
  const pHand = gameState.playerHands[pSeat];
  const bHand = gameState.playerHands[bSeat];
  if (!pHand) return 'lose';
  const pScore = getScore(pHand);
  const bScore = getScore(bHand);
  const pIsPoke = isPoke(pHand);
  const bIsPoke = isPoke(bHand);
  if (pIsPoke && !bIsPoke) return 'win';
  if (!pIsPoke && bIsPoke) return 'lose';
  if (pScore > bScore) return 'win';
  if (pScore < bScore) return 'lose';
  if (pHand.length < bHand.length) return 'win';
  if (pHand.length > bHand.length) return 'lose';
  return 'draw';
}

function broadcastGameState() {
  io.emit('gameState', {
    seats,
    players,
    gameState: {
      ...gameState,
      playerHands: gameState.status === 'ended' ? gameState.playerHands : getHiddenHands()
    }
  });
}

function getHiddenHands() {
  let hidden = {};
  for (let s in gameState.playerHands) {
    hidden[s] = gameState.playerHands[s].map(() => ({ isHidden: true }));
  }
  return hidden;
}

// ========== Core Game Loop ==========
async function startRound() {
  console.log("Checking for players to start...");
  
  // လက်ရှိထိုင်နေသူများကို စစ်ဆေးခြင်း
  const activeSeats = [];
  for (let i = 1; i <= 6; i++) {
    if (seats[i] !== null) activeSeats.push(i);
  }

  // လူ ၂ ယောက်မပြည့်မချင်း Waiting မှာပဲနေမယ်
  if (activeSeats.length < 2) {
    console.log("Not enough players:", activeSeats.length);
    gameState.status = 'waiting';
    broadcastGameState();
    setTimeout(startRound, 3000); // ၃ စက္ကန့်နေရင် ပြန်စစ်မယ်
    return;
  }

  // ဒိုင်သတ်မှတ်ခြင်း
  if (gameState.bankerId === null || !seats[gameState.bankerId]) {
    gameState.bankerId = activeSeats[0];
    gameState.bankerFund = 3000;
    gameState.bankerRoundCount = 0;
    gameState.isWantainStarted = false;
  }

  if (gameState.bankerFund >= WANTAIN_LIMIT) gameState.isWantainStarted = true;
  if (gameState.isWantainStarted) gameState.bankerRoundCount++;

  gameState.status = 'betting';
  gameState.playerBets = {};
  gameState.playerHands = {};
  gameState.winners = [];
  
  // ပါဝင်သူတိုင်းအတွက် ဖဲအိတ်အလွတ်လုပ်ပေးမယ်
  activeSeats.forEach(s => gameState.playerHands[s] = []);
  
  broadcastGameState();
  console.log("Game Status: Betting started");

  // Betting အချိန် ၁၀ စက္ကန့်
  setTimeout(() => {
    // ပွဲမစခင် လူပြန်စစ်မယ်
    const finalActive = Object.keys(seats).filter(s => seats[s] !== null);
    if (finalActive.length >= 2) {
      dealCards();
    } else {
      startRound();
    }
  }, 10000);
}

async function dealCards() {
  gameState.status = 'dealing';
  deck = createDeck();
  const activeSeats = Object.keys(gameState.playerHands).map(Number);
  const bIdx = activeSeats.indexOf(gameState.bankerId);
  
  let order = [];
  for(let i=1; i<=activeSeats.length; i++) {
    order.push(activeSeats[(bIdx + i) % activeSeats.length]);
  }

  // ၂ ချပ်စီဝေမယ်
  for (let r = 0; r < 2; r++) {
    for (let s of order) {
      const card = deck.pop();
      gameState.playerHands[s].push(card);
      io.to(seats[s]).emit('yourHand', gameState.playerHands[s]);
      broadcastGameState();
      await new Promise(res => setTimeout(res, 600));
    }
  }

  // ဒိုင် Poke စစ်မယ်
  if (isPoke(gameState.playerHands[gameState.bankerId])) {
    setTimeout(endGame, 1500);
  } else {
    runPlayerTurns(order);
  }
}

async function runPlayerTurns(order) {
  gameState.status = 'playing';
  for (let s of order) {
    if (s === gameState.bankerId || isPoke(gameState.playerHands[s])) continue;
    
    gameState.currentTurn = s;
    broadcastGameState();

    await new Promise(resolve => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          // အချိန်ပြည့်ရင် ၄ မှတ်အောက်ဆို အော်တိုဆွဲမယ်
          if (getScore(gameState.playerHands[s]) < 4) {
             gameState.playerHands[s].push(deck.pop());
             io.to(seats[s]).emit('yourHand', gameState.playerHands[s]);
          }
          resolve();
        }
      }, 15000);

      // Player က ဆွဲမယ်/ရပ်မယ် နှိပ်လိုက်ရင်
      if (players[seats[s]]) {
        players[seats[s]].currentResolve = () => {
          resolved = true;
          clearTimeout(timeout);
          resolve();
        };
      }
    });
  }

  // ဒိုင်အလှည့်
  gameState.currentTurn = gameState.bankerId;
  broadcastGameState();
  await new Promise(res => setTimeout(res, 1000));
  if (getScore(gameState.playerHands[gameState.bankerId]) < 5) {
    gameState.playerHands[gameState.bankerId].push(deck.pop());
    io.to(seats[gameState.bankerId]).emit('yourHand', gameState.playerHands[gameState.bankerId]);
    broadcastGameState();
  }
  
  setTimeout(endGame, 1500);
}

function endGame() {
  gameState.status = 'ended';
  const bSeat = gameState.bankerId;
  
  for (let s in gameState.playerHands) {
    const sNum = parseInt(s);
    if (sNum === bSeat) continue;
    
    const res = compareHands(sNum, bSeat);
    const bet = gameState.playerBets[sNum] || 0;
    const pId = seats[sNum];

    let winAmount = 0;
    if (res === 'win') {
      winAmount = bet; gameState.bankerFund -= bet;
      if (players[pId]) players[pId].balance += (bet * 2);
    } else if (res === 'lose') {
      winAmount = -bet; gameState.bankerFund += bet;
    } else {
      if (players[pId]) players[pId].balance += bet;
    }
    gameState.winners.push({ seat: sNum, winAmount });
  }

  broadcastGameState();
  checkBankerChange();
  setTimeout(startRound, 5000);
}

function checkBankerChange() {
  if (gameState.bankerFund <= 0 || (gameState.isWantainStarted && gameState.bankerRoundCount >= MAX_ROUNDS)) {
    const oldB = seats[gameState.bankerId];
    if (players[oldB]) players[oldB].balance += Math.max(0, gameState.bankerFund);
    gameState.bankerId = null;
  }
}

// ========== Socket Events ==========
io.on('connection', (socket) => {
  players[socket.id] = { id: socket.id, name: "Player_"+socket.id.slice(0,3), balance: 10000, seat: null };
  socket.emit('yourId', socket.id);
  broadcastGameState();

  socket.on('sitDown', (s) => {
    const seatNum = parseInt(s);
    if (!seats[seatNum]) { 
        seats[seatNum] = socket.id; 
        players[socket.id].seat = seatNum; 
        broadcastGameState(); 
    }
  });

  socket.on('placeBet', (amt) => {
    const s = players[socket.id].seat;
    if (gameState.status === 'betting' && s && s !== gameState.bankerId) {
      players[socket.id].balance -= amt;
      gameState.playerBets[s] = amt;
      broadcastGameState();
    }
  });

  socket.on('playerAction', (type) => {
    const s = players[socket.id].seat;
    if (gameState.currentTurn === s) {
      if (type === 'draw' && gameState.playerHands[s].length < 3) {
        gameState.playerHands[s].push(deck.pop());
        io.to(socket.id).emit('yourHand', gameState.playerHands[s]);
        broadcastGameState();
      }
      if (players[socket.id].currentResolve) players[socket.id].currentResolve();
    }
  });

  socket.on('disconnect', () => {
    const seat = players[socket.id]?.seat;
    if (seat) seats[seat] = null;
    delete players[socket.id];
    broadcastGameState();
  });
});

// ဂိမ်းကို စတင်နှိုးဆော်လိုက်မယ်
startRound();

server.listen(3000, () => console.log('Server running on port 3000'));
