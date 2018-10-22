'use strict'

const debug = (require('debug'))('neighborhood-wrtc')

const merge = require('lodash.merge')
const uuid = require('uuid/v4')
const Socket = require('simple-peer')

const ArcStore = require('./arcstore.js')
const EPending = require('./entries/epending.js')
const EDying = require('./entries/edying.js')

const INeighborhood = require('./interfaces/ineighborhood.js')

const MResponse = require('./messages/mresponse.js')
const MRequest = require('./messages/mrequest.js')
const MSend = require('./messages/msend.js')
const MInternalSend = require('./messages/minternalsend.js')

// const ExLateMessage = require('./exceptions/exlatemessage.js')
const ExProtocolExists = require('./exceptions/exprotocolexists.js')
const ExIncompleteMessage = require('./exceptions/exincompletemessage.js')

/**
 * Easy-to-use interface to establish multiple WebRTC connections using
 * SimplePeer (npm: simple-peer)
 */
class Neighborhood {
  /**
     * @param {object} [options] the options available to the connections, e.g.
     * timeout before
     * @param {object} [options.socketClass] simple-peer default socket class (usefull if you need to change the type of socket)
     * @param {object} [options.config] simple-peer options
     * @param {number} [options.timeout = 60000] Time to wait (in milliseconds) for dying socket
     * @param {number} [options.pendingTimeout = 10000] Time to wait (in milliseconds) for pending socket
     * before neighborhood-wrtc assumes that a connection establishment failed,
     * or before an unused connection is removed.
     * @param {function} [options.encoding] Method to customize message sent,
     * default: return JSON.stringify(data);
     * @param {function} [options.decoding] Method to decode a received message,
     * default: return JSON.parse(data);
     */
  constructor (options) {
    // #1 save options
    this.options = {
      socketClass: Socket,
      peer: uuid(),
      config: { trickle: true, initiator: false },
      timeout: 1 * 60 * 1000,
      pendingTimeout: 10 * 1000,
      encoding: (d) => { return JSON.stringify(d) },
      decoding: (d) => { return JSON.parse(d) }
    }
    this.options = merge(this.options, options)
    this.options.peer=this.cleanId(this.options.peer)
    this.encode = this.options.encoding // not sure it should stay that
    this.decode = this.options.decoding // way

    // #2 unmutable values
    this.PEER = this.options.peer
    debug('[%s] initialized.', this.PEER)

    // #3 initialize tables
    this.pending = new Map() // not finalized yet
    this.living = new ArcStore() // live and usable
    this.dying = new Map() // being removed

    // #4 table of all registered protocols
    this.protocols = new Map()
  }

  /**
     * The protocolId asks this module to get an interface. The interface
     * comprises functions such as connect, disconnect, or send. ProtocolId
     * should provide some functions as well such as failed, opened, received,
     * pid.
     * @param {IProtocol} protocol The protocol that requires the interface.
     * @returns {INeighborhood} The interface to use this module easily.
     */
  register (protocol) {
    if (!this.protocols.has(protocol._pid())) {
      debug('[%s] protocol %s just registered.',
        this.PEER, protocol._pid())
      this.protocols.set(protocol._pid(), protocol)
      return new INeighborhood(
        this.PEER,
        this._connect.bind(this, protocol._pid()),
        this._disconnect.bind(this, protocol._pid()),
        this._send.bind(this, protocol._pid()),
        this._stream.bind(this, protocol._pid()),
        this._neighbours.bind(this)
      )
    } else {
      throw new ExProtocolExists(protocol._pid())
    }
  }

  // (TODO) unregister ?

  /**
     * @private
     * Create a WebRTC connection.
     * @param {string} protocolId The identifier of the protocol that wishes to
     * establish an new connection.
     * @param {function|object} arg1 Either a callback function to send the
     * message to the remote peer (for instance, it can use a signaling server
     * or the already created WebRTC connexions), or a message received from the
     * remote peer.
     * @param {object} arg2 The message received from a peer that initialized a
     * WebRTC connection.
     */
  _connect (protocolId, arg1, arg2) {
    if (typeof arg1 === 'function' && typeof arg2 === 'undefined') {
      this._initiate(protocolId, arg1) // arg1: callback for offers
    } else if (typeof arg1 === 'function' && typeof arg2 !== 'undefined') {
      this._accept(protocolId, arg1, arg2) // arg1:callback, arg2:request
    } else {
      this._finalize(protocolId, arg1) // arg1: response
    }
  }

  /**
     * @private
     * Initiate the creation of a WebRTC connection. At this point, the identity
     * of the remote peer is unknown.
     * @param {string} protocolId The identifier of the protocol that creates a
     * connection.
     * @param {function} sender A function called at each offer
     */
  _initiate (protocolId, sender) {
    // #1 create an initiator
    this.options.config.initiator = true
    let SocketClass = this.options.socketClass
    let socket = new SocketClass(this.options.config)
    // #2 insert the new entry in the pending table
    let entry = new EPending(uuid(), null, protocolId, socket)
    // entry.tid = peerIdToConnectWith || entry.tid
    this.pending.set(entry.tid, entry)

    // #3 define events
    socket.once('connect', () => {

      entry.successful = true
      if (this.living.contains(this.getId(entry))) {
        entry.alreadyExists = true
        entry.successful = true
        this.living.insert(this.getId(entry), protocolId)
        debug('[%s] --- arc --> %s', this.PEER, this.getId(entry))
        this.protocols.get(protocolId)._connected(this.getId(entry), true)
        entry.peer = null // becomes the unknown soldier
      } else {
        this.living.insert(this.getId(entry), protocolId, socket)
        debug('[%s] --- WebRTC --> %s', this.PEER, this.getId(entry))
        this.protocols.get(protocolId)._connected(this.getId(entry), true)
      };

      this._checkPendingEntry(entry)
    })
    socket.once('close', () => {
      if (this.getId(entry) !== null) { // if not the unknown soldier
        if (this.living.contains(this.getId(entry))) {
          // #A remove the socket from the table of living connections
          let toNotify = this.living.removePeer(this.getId(entry))
          // #B notify all protocols that were using this socket
          toNotify.forEach((occ, pid) => {
            for (let i = 0; i < occ; ++i) {
              this.protocols.get(pid)._disconnected(this.getId(entry))
            };
          })
        } else if (this.dying.has(this.getId(entry))) {
          let d = this.dying.get(this.getId(entry))
          clearTimeout(d.timeout)
          this.dying.delete(this.getId(entry))
        };
        debug('[%s] -‡- WebRTC -‡> %s', this.PEER, this.getId(entry))
      } else {
        debug('[%s] -‡- WebRTC -‡> %s', this.PEER, 'unknown')
      };
      this._checkPendingEntry(entry)
    })

    socket.on('data', (d) => {
      let msg = this.decode(d)
      if (msg.type === 'MInternalSend') {
        this._receiveInternalMessage(msg)
      } else {
        this.protocols.get(msg.pid)._received(this.getId(msg), msg.payload)
      }
    })
    socket.on('stream', (s) => {
      this.protocols.get(entry.pid)._streamed(this.getId(entry), s)
    })
    socket.on('error', (e) => {
      // Nothing here, for the failure are detected and handled after
      // this.options.timeout milliseconds.
      debug(e)
      socket.destroy()
    })
    // #4 send offer message using sender
    socket.on('signal', (offer) => {
      if (socket.connected && !socket._isNegociating) {
        this._sendRenegociateRequest(new MRequest(entry.tid, this.PEER, protocolId, offer, 'renegociate'), this.getId(entry))
      } else {
        sender(new MRequest(entry.tid, this.PEER, protocolId, offer))
      }
    })

    // #5 check if the socket has been established correctly
    setTimeout(() => {
      // (TODO) on destroy notify protocols that still use the socket
      // (TODO) send MDisconnect messages to notify remote peer of the
      // removal of an arc
      (!entry.successful || entry.alreadyExists) && (entry.socket !== null) && entry.socket.destroy()
      !entry.successful && this.protocols.get(protocolId)._failed(this.getId(entry), true)
      this.pending.delete(entry.tid)
    }, this.options.pendingTimeout)
  };


  getId(entry){
    let id = this.cleanId(entry.peer)
    return id
  }

  cleanId(id){
    if(id){       
    const fixedPart= id.slice(0,id.length-4)
    let varPart=id.slice(id.length-4,id.length)
   
    varPart=this.removeFromString('-I',varPart)
    varPart=this.removeFromString('-O',varPart)
     return fixedPart+varPart
    } 
    return null
    }

  removeFromString(StringtoBeremove,s) {
    const indexOfLast=s.lastIndexOf(StringtoBeremove)

    if(indexOfLast>=0) {
        s= s.slice(0,indexOfLast)+s.slice(indexOfLast+StringtoBeremove.length)
    }
    return s  
  }
  /**
     * @private
     * Try to finalize the WebRTC connection using the remote offers.
     * @param {string} protocolId The identifier of the protocol that wishes to
     * open a connection.
     * @param {MResponse} msg The message containing an offer, a peerId etc.
     */
  _finalize (protocolId, msg) {
    if (msg.offerType === 'renegociate') {
      debug(`[%s] _finalize regenociation:`, msg)
      if (this.living.store.has(this.getId(msg))) {
        const socket = this.living.get(this.getId(msg)).socket
        socket.connected && !socket._isNegociating && socket.signal(msg.offer)
      }
      return
    }
    if (!this.pending.has(msg.tid)) {
      // debug(new ExLateMessage('_finalize', msg))
      return
    };

    let entry = this.pending.get(msg.tid)
    if (entry) {
      if (entry.alreadyExists || entry.successful) {
        this._checkPendingEntry(entry)
        debug('The socket already exists: ', this.getId(entry))
        return
      }
    }

    // #A check if the connection already exists
    if (this.living.contains(this.getId(msg))) {
      entry.alreadyExists = true
      entry.successful = true
      this.living.insert(this.getId(msg), protocolId)
      debug('[%s] --- arc --> %s', this.PEER, this.getId(msg))
      this.protocols.get(protocolId)._connected(this.getId(msg), true)

      this._checkPendingEntry(entry)
    } else if (this.dying.has(this.getId(msg))) {
      // #B rise from the dead
      entry.alreadyExists = true
      entry.successful = true
      let rise = this.dying.get(this.getId(msg))
      clearTimeout(rise.timeout)
      this.dying.delete(this.getId(msg))
      this.living.insert(this.getId(msg), protocolId, rise.socket)
      debug('[%s] -¡- arc -¡> %s', this.PEER, this.getId(msg))
      this.protocols.get(protocolId)._connected(this.getId(msg), true)

      this._checkPendingEntry(entry)
    } else {
      // #C just signal the offer
      entry.peer = this.getId(msg)
      if (!msg.offer) {
       // throw new ExIncompleteMessage('_finalize', entry, msg)
      } else {
        entry.socket.signal(msg.offer)
      };
    };
  };

  /**
     * @private
     * Establish a connection in response to the request of remote peer.
     * @param {string} protocolId The identifier of the protocol that wishes to
     * create a connection.
     * @param {function} sender The function that send the offer to the remote
     * initiating peer.
     * @param {MRequest} msg The request message containing offers, peerId, etc.
     **/
  _accept (protocolId, sender, msg) {
    if (msg.offerType === 'renegociate') {
      debug(`[%s] _accept regenociation:`, msg)
      if (this.living.store.has(this.getId(msg))) {
        this.living.get(this.getId(msg)).socket.signal(msg.offer)
      }
      return
    }
    // #1 initialize the entry if it does not exist
    let firstCall = false
    const tid = msg.tid
    const peer = this.getId(msg)
    if (!this.pending.has(tid)) {
      firstCall = true
      let entry = new EPending(tid, peer, protocolId)
      this.pending.set(tid, entry)

      setTimeout(() => {
        (!entry.successful || entry.alreadyExists) && entry.socket && entry.socket.destroy()
        !entry.successful && this.protocols.get(protocolId)._failed(peer, false)
        this.pending.delete(tid)
      }, this.options.pendingTimeout)
    }

    // #2 check if a WebRTC connection to peerId already exists
    let entry = this.pending.get(msg.tid)
    // let entry = this.pending.get(peer);
    if (entry.alreadyExists || entry.successful) { return };

    // #A check if the connection already exists
    if (this.living.contains(this.getId(msg))) {
      entry.alreadyExists = true
      entry.successful = true
      this.living.insert(this.getId(msg), protocolId)
      debug('[%s] <-- arc --- %s', this.PEER, this.getId(entry))
      this.protocols.get(protocolId)._connected(this.getId(msg), false)
      firstCall && sender(new MResponse(entry.tid, this.PEER, protocolId, null))

      this._checkPendingEntry(entry)
    } else if (this.dying.has(this.getId(msg))) {
      // #B rise from the dead
      entry.alreadyExists = true
      entry.successful = true
      let rise = this.dying.get(this.getId(msg))
      clearTimeout(rise.timeout)
      this.dying.delete(this.getId(msg))
      this.living.insert(this.getId(msg), protocolId, rise.socket)
      debug('[%s] <¡- arc -¡- %s', this.PEER, this.getId(msg))
      this.protocols.get(protocolId)._connected(this.getId(msg), false)
      firstCall && sender(new MResponse(entry.tid, this.PEER, protocolId, null))

      // delete the pending entry cause we do not use the created one if exists
      this._checkPendingEntry(entry)
    } else {
      // #3 create the events and signal the offer
      if (firstCall && !entry.socket) {
        // #A create a socket
        this.options.config.initiator = false
        let SocketClass = this.options.socketClass
        let socket = new SocketClass(this.options.config)
        // #B update the entry
        entry.socket = socket
        // #C define events
        socket.once('connect', () => {
          entry.successful = true
          if (this.living.contains(this.getId(entry))) {
            entry.alreadyExists = true
            entry.successful = true
            this.living.insert(this.getId(entry), protocolId)
            debug('[%s] <-- arc --- %s', this.PEER, this.getId(entry))
            this.protocols.get(protocolId)._connected(this.getId(entry),
              false)
            entry.peer = null // becomes the unknown soldier
          } else {
            this.living.insert(this.getId(entry), protocolId, socket)
            debug('[%s] <-- WebRTC --- %s', this.PEER, this.getId(entry))
            this.protocols.get(protocolId)._connected(this.getId(entry),
              false)
          };

          this._checkPendingEntry(entry)
        })
        socket.once('close', () => {
          if (this.getId(entry) !== null) { // if not the unknown soldier
            if (this.living.contains(this.getId(entry))) {
              // #A remove the socket from the table of
              // living connections
              let toNotify = this.living.removePeer(this.getId(entry))
              // #B notify all protocols that were using
              // this socket
              toNotify.forEach((occ, pid) => {
                for (let i = 0; i < occ; ++i) {
                  this.protocols.get(pid)
                    ._disconnected(this.getId(entry))
                };
              })
            } else if (this.dying.has(this.getId(entry))) {
              let d = this.dying.get(this.getId(entry))
              clearTimeout(d.timeout)
              this.dying.delete(this.getId(entry))
            };
            debug('[%s] <‡- WebRTC -‡- %s', this.PEER, this.getId(entry))
          } else {
            debug('[%s] <‡- WebRTC -‡- %s', this.PEER, 'unknown')
          };
          this._checkPendingEntry(entry)
        })

        socket.on('data', (d) => {
          let msg = this.decode(d)
          if (msg.type === 'MInternalSend') {
            this._receiveInternalMessage(msg)
          } else {
            this.protocols.get(msg.pid)._received(this.getId(msg), msg.payload)
          }
        })
        socket.on('stream', (s) => {
          this.protocols.get(entry.pid)._streamed(this.getId(entry), s)
        })
        socket.on('error', (e) => {
          // Nothing here, for the failure are detected and handled
          // after this.options.timeout milliseconds.
          debug(e)
          socket.destroy()
        })
        // #4 send offer message using sender
        socket.on('signal', (offer) => {
          if (socket.connected && !socket._isNegotiating) {
            this._sendRenegociateResponse(new MResponse(entry.tid, this.PEER, protocolId, offer, 'renegociate'), this.getId(entry))
          } else {
            sender(new MResponse(entry.tid, this.PEER, protocolId, offer))
          }
        })
      };
      entry.socket.signal(msg.offer)
    };
  };

  /**
     * @private
     * Remove an arc from protocolId leading to peerId. If it was the last arc,
     * the WebRTC connexion is downgraded to the dying table. In this table, the
     * connexion will be closed if none create it.
     * @param {string} protocolId The identifier of the protocol that removes an
     * arc
     * @param {string|undefined} peerId The identifier of the peer. If no arg,
     * remove all arcs of protocolId.
     */
  _disconnect (protocolId, peerId) {
    peerId=this.cleanId(peerId)
    if (typeof peerId === 'undefined') {
      // #1 remove all arcs
      var entries = this.living.removeAll(protocolId)
      entries.forEach((entry) => {
        if (entry.socket !== null) {
          var dying = new EDying(this.getId(entry),
            entry.socket,
            setTimeout(() => {
              entry.socket && entry.socket.destroy()
            }, this.options.timeout))
          this.dying.set(dying.peer, dying)
        };

        for (let i = 0; i < entry.occ; ++i) {
          if (entry.socket === null ||
                        (entry.socket !== null && i < entry.occ - 1)) {
            debug('[%s] ††† arc ††† %s', this.PEER, peerId)
          } else {
            debug('[%s] ††† WebRTC ††† %s', this.PEER, peerId)
          };
          this.protocols.get(protocolId)._disconnected(this.getId(entry))
        };
      })
    } else {
      var entry = null
      // #2 remove one arc
      try {
        entry = this.living.remove(peerId, protocolId)
      } catch (e) {
        console.log(e) // dangerous
        // noop
      }
      if (entry) {
        var dying = new EDying(this.getId(entry), entry.socket, setTimeout(() => {
          entry.socket && entry.socket.destroy()
        }, this.options.timeout))
        this.dying.set(dying.peer, dying)
        debug('[%s] ††† WebRTC ††† %s', this.PEER, peerId)
      } else {
        debug('[%s] ††† arc ††† %s', this.PEER, peerId)
      };
      this.protocols.get(protocolId)._disconnected(peerId)
    };
  };

  /**
     * @private
     * Send a message to a remote peer. It encapsulates the message
     * from protocolId to help the remote peer to route the message to the
     * proper protocol.
     * @param {string} protocolId The identifier of the protocol sending the
     * message
     * @param {string} peerId The remote peer to send the message to.
     * @param {object} message The message to send.
     * @param {number} [retry=0] Retry few times to send the message before
     * giving up.
     * @returns {promise} Resolved when the message is sent, reject
     * otherwise. Note that loss of messages is not handled by default.
     */
  _send (protocolId, peerId, message, retry = 0) {

    peerId=this.cleanId(peerId)
    return new Promise((resolve, reject) => {
      // #1 get the proper entry in the tables
      let entry = null
      if (this.living.contains(peerId)) {
        entry = this.living.get(peerId)
      } else if (this.dying.has(peerId)) {
        entry = this.dying.get(peerId) // (TODO) warn: not safe
      };
      if (entry === null) {
        reject(new Error('peer not found: ' + peerId))
      }
      // #2 define the recursive sending function
      let __send = (r) => {
        try {
          entry.socket.send(this.encode(new MSend(this.PEER,
            protocolId,
            message)))
          debug('[%s] --- msg --> %s:%s',
            this.PEER, peerId, protocolId)
          resolve()
        } catch (e) {
          debug('[%s] -X- msg -X> %s:%s',
            this.PEER, peerId, protocolId)
          if (r < retry) {
            setTimeout(() => { __send(r + 1) }, 1000)
          } else {
            reject(e)
          };
        };
      }
      // #3 start to send
      __send(0)
    })
  };

  _stream (protocolId, peerId, media, retry = 0) {
    peerId=this.cleanId(peerId)
    return new Promise((resolve, reject) => {
      // #1 get the proper entry in the tables
      let entry = null
      if (this.living.contains(peerId)) {
        entry = this.living.get(peerId)
      } else if (this.dying.has(peerId)) {
        entry = this.dying.get(peerId) // (TODO) warn: not safe
      };
      if (entry === null) {
        this.living.store.forEach(elem => {
          debug(elem.peer)
        })
        reject(new Error('peer not found: ' + peerId))
      }
      // #2 define the recursive sending function
      let __send = (r) => {
        try {
          entry.socket.addStream(media)
          debug('[%s] --- MEDIA msg --> %s:%s',
            this.PEER, peerId, protocolId)
          resolve()
        } catch (e) {
          debug('[%s] -X- MEDIA msg -X> %s:%s',
            this.PEER, peerId, protocolId)
          if (r < retry) {
            setTimeout(() => { __send(r + 1) }, 1000)
          } else {
            reject(e)
          };
        };
      }
      // #3 start to send
      __send(0)
    })
  }

  _sendRenegociateRequest (request, to, retry = 0) {
    return new Promise((resolve, reject) => {
      // #1 get the proper entry in the tables
      let entry = null
      if (this.living.contains(to)) {
        entry = this.living.get(to)
      } else if (this.dying.has(to)) {
        entry = this.dying.get(to) // (TODO) warn: not safe
      };
      if (entry === null) {
        this.living.store.forEach(elem => {
          debug(elem.peer)
        })
        reject(new Error('peer not found: ' + to))
      }
      // #2 define the recursive sending function
      let __send = (r) => {
        try {
          entry.socket.send(this.encode(new MInternalSend(this.PEER, null, request)))
          debug('[%s] --- MEDIA Internal Renegociate msg --> %s:%s',
            this.PEER, to)
          resolve()
        } catch (e) {
          debug('[%s] -X- MEDIA Internal Renegociate msg -X> %s:%s',
            this.PEER, to)
          if (r < retry) {
            setTimeout(() => { __send(r + 1) }, 1000)
          } else {
            reject(e)
          };
        };
      }
      // #3 start to send
      __send(0)
    })
  }

  _sendRenegociateResponse (response, to, retry = 0) {
    return new Promise((resolve, reject) => {
      // #1 get the proper entry in the tables
      let entry = null
      if (this.living.contains(to)) {
        entry = this.living.get(to)
      } else if (this.dying.has(to)) {
        entry = this.dying.get(to) // (TODO) warn: not safe
      };
      if (entry === null) {
        this.living.store.forEach(elem => {
          debug(elem.peer)
        })
        reject(new Error('peer not found: ' + to))
      }
      // #2 define the recursive sending function
      let __send = (r) => {
        try {
          entry.socket.send(this.encode(new MInternalSend(this.PEER, null, response)))
          debug('[%s] --- MEDIA Internal Renegociate msg --> %s:%s',
            this.PEER, to)
          resolve()
        } catch (e) {
          debug('[%s] -X- MEDIA Internal Renegociate msg -X> %s:%s',
            this.PEER, to)
          if (r < retry) {
            setTimeout(() => { __send(r + 1) }, 1000)
          } else {
            reject(e)
          };
        };
      }
      // #3 start to send
      __send(0)
    })
  }

  _receiveInternalMessage (msg) {
    this.living.get(this.getId(msg)).socket.signal(msg.payload.offer)
  }

  _neighbours () {
    const neigh = []
    this.living.store.forEach(elem => {
      neigh.push(elem)
    })
    return neigh
  }

  _checkPendingEntry (entry) {
    if (this.pending.has(entry.tid)) {
      if (this.getId(entry) === null) {
        if (entry.socket) {
          entry.socket.destroy()
          entry.socket = null
        }
      }
      this.pending.delete(entry.tid)
    }
  }
};

module.exports = Neighborhood
