'use strict';

/**
 * Interface of functions that are available to a protocol that registered
 * to this module.
 * @param {func} connect The connection function provided by this module.
 * @param {func} disconnect The disconnection function provided by this module.
 * @param {func} send The send function provided by this module.
 */
class INeighborhood {
    constructor (connect, disconnect, send) {
        this.connect = connect;
        this.disconnect = disconnect;
        this.send = send;        
    };

    /**
     * Create a WebRTC connexion.
     * @param {func|object} arg1 Either a callback function to send the message
     * to the remote peer (for instance, it can use a signaling server or the
     * already created WebRTC connexions), or a message received from the remote
     * peer.
     * @param {object} arg2 The message received from a peer that initialized a 
     * WebRTC connexion.
     */
    connect (arg1, arg2) {
        this.connect(arg1, arg2);
    };
        
    /**
     * Remove an arc that led to peerId.
     * @param {string} peerId The identifier of the remote peer.
     * @returns {promise} Resolved when the arc is removed.
     */
    disconnect (peerId) {
        return this.disconnect(peerId);
    };

    /**
     * Send message to peerId.
     * @param {string} peerId The identifier of the remote peer.
     * @param {string} message The message to send.
     * @returns {promise} Resolved when the message has been sent.
     */
    send (peerId, message){
        return this.send(peerId, message);
    };
};

module.exports = INeighborhood;