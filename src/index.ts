import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer });
interface Player {
  id: string;
  name: string;
  position: number;
  color: string;
}
interface GameRoom {
  id: string;
  code: string;
  players: Player[];
  currentTurn: number;
  gameState: 'waiting' | 'playing' | 'finished';
  snakesAndLadders: { [key: number]: number };
  boardSize: number;
  winner: string | null;
}
const activeGames = new Map<string, GameRoom>();
const playerConnections = new Map<string, any>();
function generateRoomCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}
function createSnakesAndLadders(): { [key: number]: number } {
  return {
    // Ladders (start -> end)
    1: 38,
    4: 14,
    9: 31,
    21: 42,
    28: 84,
    51: 67,
    72: 91,
    80: 99,
    // Snakes (start -> end)
    16: 6,
    47: 26,
    49: 11,
    56: 53,
    62: 19,
    64: 60,
    87: 24,
    93: 73,
    95: 75,
    98: 78,
  };
}
function broadcastToRoom(roomId: string, message: any): void {
  try {
    const room = activeGames.get(roomId);
    if (!room) return;
    room.players.forEach(player => {
      const connection = playerConnections.get(player.id);
      if (connection && connection.readyState === 1) {
 connection.send(JSON.stringify(message));
      }
    });
  } catch (error) {
    console.error('Error broadcasting to room:', error);
  }
}

function sendError(ws: any, message: string): void {
  try {
    ws.send(JSON.stringify({
      type: 'ERROR',
      message
    }));
  } catch (error) {
    console.error('Error sending error message:', error);
  }
}
wss.on('connection', (ws) => {
  let playerId: string | null = null;
  let currentRoomId: string | null = null;
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      switch (data.type) {
        case 'CREATE_ROOM': {
          try {
            if (!data.playerName) {
              return sendError(ws, 'Player name is required');
            }
            const roomId = randomUUID();
            const roomCode = generateRoomCode();
            playerId = randomUUID();
            const player: Player = {
              id: playerId,
              name: data.playerName,
              position: 0,
              color: data.color || '#' + Math.floor(Math.random()*16777215).toString(16)
            };
            const newRoom: GameRoom = {
              id: roomId,
              code: roomCode,
              players: [player],
              currentTurn: 0,
              gameState: 'waiting',
              snakesAndLadders: createSnakesAndLadders(),
              boardSize: 100,
              winner: null
            };
            activeGames.set(roomId, newRoom);
            playerConnections.set(playerId, ws);
            currentRoomId = roomId
            await prisma.gameRoom.create({
              data: {
                id: roomId,
                code: roomCode,
                status: 'waiting',
                players: {
                  create: {
                    id: playerId,
                    name: player.name,
                    color: player.color
                  }
                }
              }
            });
            ws.send(JSON.stringify({
              type: 'ROOM_CREATED',
              room: {
                id: roomId,
                code: roomCode,
                players: [player],
                gameState: 'waiting'
              },
              playerId
            }));
          } catch (error) {
            console.error('Error creating room:', error);
            sendError(ws, 'Failed to create room');
          }
          break;
        }
        case 'GET_ROOM_STATE': {
          try {
            const { roomCode, playerId: incomingPlayerId } = data;
            if (!roomCode) {
              return sendError(ws, 'Room code is required');
            }
            const roomEntry = Array.from(activeGames.entries())
              .find(([_, room]) => room.code === roomCode);
            if (!roomEntry) {
              const dbRoom = await prisma.gameRoom.findFirst({
                where: { code: roomCode },
                include: { players: true }
              });
              if (!dbRoom) {
                return sendError(ws, 'Room not found');
              }
              const restoredRoom: GameRoom = {
                id: dbRoom.id,
                code: dbRoom.code,
                players: dbRoom.players.map(p => ({
                  id: p.id,
                  name: p.name,
                  position: 0,
                  color: p.color || '#000000' 
                })),
                currentTurn: 0,
                gameState: dbRoom.status === 'inactive' ? 'waiting' : dbRoom.status as any,
                snakesAndLadders: createSnakesAndLadders(),
                boardSize: 100,
                winner: dbRoom.winnerId
              };
              if (incomingPlayerId && restoredRoom.players.some(p => p.id === incomingPlayerId)) {
                playerId = incomingPlayerId;
                currentRoomId = dbRoom.id;
                playerConnections.set(incomingPlayerId, ws);
              }
              ws.send(JSON.stringify({
                type: 'ROOM_STATE',
                room: restoredRoom
              }));
              activeGames.set(dbRoom.id, restoredRoom);
              if (dbRoom.status === 'inactive') {
                await prisma.gameRoom.update({
                  where: { id: dbRoom.id },
                  data: { status: 'waiting' }
                });
              }
            } else {
              const [roomId, room] = roomEntry;
              if (incomingPlayerId && room.players.some(p => p.id === incomingPlayerId)) {
                playerId = incomingPlayerId;
                currentRoomId = roomId;
                playerConnections.set(incomingPlayerId, ws);
              }              
              ws.send(JSON.stringify({
                type: 'ROOM_STATE',
                room
              }));
            }
          } catch (error) {
            console.error('Error getting room state:', error);
            sendError(ws, 'Failed to get room state');
          }
          break;
        }        
        case 'JOIN_ROOM': {
          try {
            const { roomCode, playerName, color } = data;          
            if (!roomCode || !playerName) {
              return sendError(ws, 'Room code and player name are required');
            }           
            const roomEntry = Array.from(activeGames.entries())
              .find(([_, room]) => room.code === roomCode);           
            if (!roomEntry) {
              const dbRoom = await prisma.gameRoom.findFirst({
                where: { code: roomCode, status: 'waiting' },
                include: { players: true }
              });
              if (!dbRoom) {
                return sendError(ws, 'Room not found or game already started');
              }
              const restoredRoom: GameRoom = {
                id: dbRoom.id,
                code: dbRoom.code,
                players: dbRoom.players.map(p => ({
                  id: p.id,
                  name: p.name,
                  position: 0,
                  color: p.color || '#000000'
                })),
                currentTurn: 0,
                gameState: dbRoom.status as any,
                snakesAndLadders: createSnakesAndLadders(),
                boardSize: 100,
                winner: null
              };
              activeGames.set(dbRoom.id, restoredRoom);
              playerId = randomUUID();
              const player: Player = {
                id: playerId,
                name: playerName,
                position: 0,
                color: color || '#' + Math.floor(Math.random()*16777215).toString(16)
              };
              restoredRoom.players.push(player);
              playerConnections.set(playerId, ws);
              currentRoomId = dbRoom.id;
              await prisma.player.create({
                data: {
                  id: playerId,
                  name: player.name,
                  color: player.color,
                  gameRoomId: dbRoom.id
                }
              }); 
              broadcastToRoom(currentRoomId, {
                type: 'PLAYER_JOINED',
                player,
                roomState: restoredRoom
              });
              ws.send(JSON.stringify({
                type: 'ROOM_JOINED',
                room: restoredRoom,
                playerId
              }));
            } else {
              const [roomId, room] = roomEntry;
              if (room.gameState !== 'waiting') {
                return sendError(ws, 'Game already started');
              }
              playerId = randomUUID();
              const player: Player = {
                id: playerId,
                name: playerName,
                position: 0,
                color: color || '#' + Math.floor(Math.random()*16777215).toString(16)
              };
              room.players.push(player);
              playerConnections.set(playerId, ws);
              currentRoomId = roomId;
              await prisma.player.create({
                data: {
                  id: playerId,
                  name: player.name,
                  color: player.color,
                  gameRoomId: roomId
                }
              }); 
              broadcastToRoom(roomId, {
                type: 'PLAYER_JOINED',
                player,
                roomState: room
              });
              ws.send(JSON.stringify({
                type: 'ROOM_JOINED',
                room,
                playerId
              }));
            }
          } catch (error) {
            console.error('Error joining room:', error);
            sendError(ws, 'Failed to join room');
          }
          break;
        }
        case 'START_GAME': {
          try {
            if (!currentRoomId) {
              return sendError(ws, 'No active room');
            }
            const room = activeGames.get(currentRoomId);
            if (!room) {
              return sendError(ws, 'Room not found');
            }
            if (room.players.length < 2) {
              return sendError(ws, 'Need at least 2 players to start');
            }
            room.gameState = 'playing';
            await prisma.gameRoom.update({
              where: { id: currentRoomId },
              data: { status: 'playing' }
            });
            broadcastToRoom(currentRoomId, {
              type: 'GAME_STARTED',
              roomState: room
            });
          } catch (error) {
            console.error('Error starting game:', error);
            sendError(ws, 'Failed to start game');
          }
          break;
        }
        case 'ROLL_DICE': {
          try {
            if (!currentRoomId || !playerId) {
              return sendError(ws, 'Invalid session state');
            }
            const room = activeGames.get(currentRoomId);
            if (!room || room.gameState !== 'playing') {
              return sendError(ws, 'Game not in playing state');
            }
            const playerIndex = room.players.findIndex(p => p.id === playerId);
            if (playerIndex === -1) {
              return sendError(ws, 'Player not found in game');
            }
            if (playerIndex !== room.currentTurn) {
              return sendError(ws, 'Not your turn');
            }
            const diceValue = Math.floor(Math.random() * 6) + 1;
            const player = room.players[playerIndex];
            let newPosition = player.position + diceValue;
            if (room.snakesAndLadders[newPosition]) {
              newPosition = room.snakesAndLadders[newPosition];
            }
            if (newPosition >= room.boardSize) {
              newPosition = room.boardSize;
              room.gameState = 'finished';
              room.winner = player.id;
              await prisma.gameRoom.update({
                where: { id: currentRoomId },
                data: { 
                  status: 'finished',
                  winnerId: player.id
                }
              });
            }
            player.position = newPosition;
            room.currentTurn = (room.currentTurn + 1) % room.players.length;
            broadcastToRoom(currentRoomId, {
              type: 'PLAYER_MOVED',
              playerId: player.id,
              diceValue,
              newPosition,
              nextTurn: room.currentTurn,
              gameState: room.gameState,
              winner: room.winner
            });
          } catch (error) {
            console.error('Error rolling dice:', error);
            sendError(ws, 'Failed to roll dice');
          }
          break;
        }
        case 'RESET_GAME': {
          try {
            if (!currentRoomId) {
              return sendError(ws, 'No active room');
            }
            const room = activeGames.get(currentRoomId);
            if (!room) {
              return sendError(ws, 'Room not found');
            }
            room.players.forEach(p => p.position = 0);
            room.currentTurn = 0;
            room.gameState = 'playing';
            room.winner = null;
            await prisma.gameRoom.update({
              where: { id: currentRoomId },
              data: { 
                status: 'playing',
                winnerId: null
              }
            });
            broadcastToRoom(currentRoomId, {
              type: 'GAME_RESET',
              roomState: room
            });
          } catch (error) {
            console.error('Error resetting game:', error);
            sendError(ws, 'Failed to reset game');
          }
          break;
        }
        default: {
          sendError(ws, 'Unknown message type');
        }
      }
    } catch (error) {
      console.error('Error processing message:', error);
      sendError(ws, 'Error processing request');
    }
  });
  ws.on('close', async () => {
    try {
      if (playerId && currentRoomId) {
        const room = activeGames.get(currentRoomId);
        if (room) {
          const playerIndex = room.players.findIndex(p => p.id === playerId);
          if (playerIndex !== -1) {
            room.players.splice(playerIndex, 1);
            if (room.players.length === 0) {
              activeGames.delete(currentRoomId);
              await prisma.gameRoom.update({
                where: { id: currentRoomId },
                data: { status: 'inactive' }
              });
            } else {
              if (playerIndex < room.currentTurn) {
                room.currentTurn--;
              } else if (playerIndex === room.currentTurn) {
                room.currentTurn %= room.players.length;
              }
              broadcastToRoom(currentRoomId, {
                type: 'PLAYER_LEFT',
                playerId,
                roomState: room
              });
            }
          }
        }
        playerConnections.delete(playerId);
      }
    } catch (error) {
      console.error('Error handling connection close:', error);
    }
  });
});

process.on('SIGINT', async () => {
  try {
    console.log('Shutting down server...');
    await prisma.$disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

const PORT = process.env.PORT || 10000;
httpServer.listen(10000, '0.0.0.0',() => {
  console.log(`WebSocket server running on  0.0.0.0:10000`);
});