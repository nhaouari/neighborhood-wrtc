'use_strict'
var Neighborhood = require('./lib/neighborhood')
var wrtc=require('wrtc')



class P { // check IProtocol to see the interface
    constructor (pid, peer) {
      this.id = pid
      this.peer = peer
    };
  
    _pid () { return this.id };
  
    _connected (peerId) {
      console.log('@%s-P%s: an arc has been created.', this.peer, this.id)
    };
  
    _disconnected (peerId) {
      console.log('@%s-P%s: an arc has been removed.', this.peer, this.id)
    };
  
    _received (peerId, message) {
      console.log('@%s-P%s: message received from @%s: %s',
        this.peer, this.id, peerId, message)
    };
  
    _streamed (peerId, stream) {
      console.log('Receive a stream from: %s', peerId, stream)
    }
  
    _failed (peerId) {
      console.log('%s-P%s: failed to establish a connection with %s.',
        this.peer, this.id, peerId)
    };
  };
  
  // create the Peer
  const n1 = new Neighborhood({
    peer: 'myid1',
    config: {
      trickle: true,
      wrtc
    }
  })
  // create the protocol
  const p1 = n1.register(new P('mywonderfullprotocol', 'myid1'))
  
  // create the Peer
  const n2 = new Neighborhood({
    peer: 'myid2',
    config: {
      trickle: true,
      wrtc
    }
  })
  // create the protocol
  const p2 = n2.register(new P('mywonderfullprotocol', 'myid2'))
  
  // now connec them
  // #3 callback functions ensuring the peers exchanges messages
  // from -> to -> from
  const callback = (from, to) => {
    return (offer) => {
      to.connect((answer) => { from.connect(answer) }, offer)
    }
  }
  
  // #4 establishing a connection from p1 to p2
  p1.connect(callback(p1, p2))
  // now p1 can send message to p2 and p2 can send message to p1
  //
  // call any function of [the following API](https://ran3d.github.io/neighborhood-wrtc/class/lib/interfaces/ineighborhood.js~INeighborhood.html)

  // send a message
  setTimeout(() => {
    p1.send(n2.PEER, 'Hello! :3').then(() => {
      console.log('First message sent')
    })
    p2.send(n1.PEER, 'Hello! :3')
  }, 1000)
  
