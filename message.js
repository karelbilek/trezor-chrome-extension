'use strict';
var Messages = require('./messages_proto');
var ByteBuffer   = require('protobufjs').ByteBuffer;
var Long = require("protobufjs").Long;


var Message = function(type, arrayBuffer) {
  this.type = type;
  this.data = arrayBuffer;
};

Message.prototype.getMethod = function() {
  // TODO: This is kinda crappy
  var found;
  for(var method in Messages.MessageType) {
    var value = Messages.MessageType[method];
    if(value == this.type) {
      found = method.split('_')[1];
    }
  }
  return found;
};

Message.prototype.decode = function() {
  var method = this.getMethod();
  if(!method) {
      return null;
  }
  return Messages[method].decode(this.data);
};

Message.prototype.hexDecode = function() {
    var decoded = this.decode();
    objToJS(decoded);
    return decoded;
}

function objToJS(obj) {
    for (var key in obj) {
        var value = obj[key];
        if (value instanceof ByteBuffer) {
            var hex = value.toHex();
            obj[key] = hex;
        } else if (value instanceof Long) {
            var num = value.toNumber();
            obj[key] = num;
        } else if (Array.isArray(value)) {
            var decodedArr = value.forEach(function(i){
                if (typeof i === "object") {
                    objToJS(i);
                }
            });
        }
    }
    
}

module.exports = Message;
