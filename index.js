'use strict';

var Promise = require('promise');
var Messages = require('./messages_proto');
var Message = require('./message');
var ByteBuffer   = require('protobufjs').ByteBuffer;

var ProtoBuf   = require('protobufjs');
//Messages.GetAddress.prototype.$type.getChildren()[0]
//magic constants

ProtoBuf.Reflect.Message.Field.prototype.verifyValueOriginal = ProtoBuf.Reflect.Message.Field.prototype.verifyValue;

ProtoBuf.Reflect.Message.Field.prototype.verifyValue = function(value, skipRepeated) {
    var newValue;
    if (this.type === ProtoBuf.TYPES["bytes"]){
        newValue = ByteBuffer.wrap(value, "hex");
    } else {
        newValue = value;
    }
    return this.verifyValueOriginal(newValue, skipRepeated);
}

var HEADER_SIZE = 8; //originally - 1 + 1 + 4 + 2;
var MESSAGE_HEADER_BYTE = 35;
var BUFFER_SIZE = 63;
var REPORT_ID = 63;

//an object with deviceId => connectionId mapping

var connections = {};

var hidEnumerate = function() {
    return new Promise(function(resolve) {
        chrome.hid.getDevices(
            { vendorId: 0x534c, productId: 0x0001 },
            function(devices) {
                resolve(devices)
            }
        );
    });
}

var devicesToJson = function(devices) {
    
    function compare(a,b) {
      if (a.deviceId < b.deviceId)
         return -1;
      if (a.deviceId > b.deviceId)
        return 1;
      return 0;
    }
    
    return devices.sort(compare).map(function(device){
        var path = device.deviceId;
        var vendor = device.vendorId;
        var product = device.productId;
        var serialNumber = ""; //TODO: is this needed?
        var session = connections[path];
        return {
            path:path,
            vendor:vendor,
            product:product,
            serialNumber:serialNumber,
            session:session
        };
    });
}


var jsonEnumerate = function() {
    return hidEnumerate().then(function(devices){
        return devicesToJson(devices);
    });
}

//---------protobuf magic

var buildBuffers = function(msg_name, data) {
    
    var ProtoBufLocal = ProtoBuf;
    
    //before it arrives to ProtobufJs, I need to convert hex to ByteBuffer
    //console.log("pokus6", Messages);
    
    var msg;
    if(data) {
       msg = new Messages[msg_name](data);
    } else {
       msg = new Messages[msg_name]();
    }
     var msg_type = Messages.MessageType['MessageType_' + msg_name];

     // magic code, copied from trhid
     // I am not sure how it works at all, but it works
     var msg_ab = new Uint8Array(msg.encodeAB());
     var header_size = HEADER_SIZE;
     var full_size = header_size + msg_ab.length;
     var msg_full = new ByteBuffer(header_size + full_size);
     msg_full.writeByte(MESSAGE_HEADER_BYTE);
     msg_full.writeByte(MESSAGE_HEADER_BYTE);
     msg_full.writeUint16(msg_type);
     msg_full.writeUint32(msg_ab.length);
     msg_full.append(msg_ab);
     var arrayBuffer = new Uint8Array(msg_full.buffer);
     var resArray = [];
     
     var c = Math.round((arrayBuffer.length-1)/BUFFER_SIZE)+1;
     for (var i=0; i<c; i++) {
         var slice = arrayBuffer.subarray(i*BUFFER_SIZE, (i+1)*BUFFER_SIZE);
         var newArray = new Uint8Array(BUFFER_SIZE);
         newArray.set(slice);
         resArray.push(newArray.buffer);
     }
     
     
     return resArray;
}

function receive(id) {
    console.log("start reg receive", id);
    
    return bufferReceive(id).then(function(obj){
        var headers = obj.headers;
        var buffer = obj.buffer;
        var msg = new Message(headers[0], buffer);
        return {message:msg.hexDecode(), type:msg.getMethod()};
    });
}

function bufferReceive(id) {
  return new Promise(function(resolve, reject) {
      console.log("start buff receive", id);
    rawReceive(id).then(function(report) {
        console.log("buff receive 2");
        
      var headers = parseHeadersAndCreateByteBuffer(report.data);
      if (headers == null) {
          console.log("buff receive 3");
          
        reject("Failed to parse headers.");
      } else {
          console.log("buff receive 4");
          
        receiveMoreOfMessageBody(id, headers[2], headers[1])
          .then(function(byteBuffer) {
              console.log("buff receive 5");
              
            byteBuffer.reset();
            console.log("buff receive 6, resolving");
            
            resolve({headers:headers,buffer:byteBuffer.toArrayBuffer()});
          });
      }
    });
  });
}

function rawReceive(id) {
    if (id == null) {
        Promise.reject("No ID to rawReceive");
    }
    return new Promise(function(resolve, reject) {
        console.log("start rawReceive", id);
        chrome.hid.receive(id, function(reportId, data) {
            if (chrome.runtime.lastError) {
                console.log("reject rawReceive");
                
                reject(chrome.runtime.lastError.message);
            } else {
                console.log("resolve rawReceive");
                
                resolve({id: reportId, data: data});
            }
        });
    });
};

function parseHeadersAndCreateByteBuffer (first_msg) {
  var msg = ByteBuffer.concat([first_msg]);
  var original_length = msg.limit;

  var sharp1 = msg.readByte();
  var sharp2 = msg.readByte();
  if (sharp1 != MESSAGE_HEADER_BYTE || sharp2 != MESSAGE_HEADER_BYTE) {
    console.error("Didn't receive expected header signature.");
    return null;
  }
  var messageType = msg.readUint16();
  var messageLength = msg.readUint32();
  var messageBuffer = new ByteBuffer(messageLength);
  messageBuffer.append(msg);

  return [messageType, messageLength, messageBuffer];
};

function receiveMoreOfMessageBody(id, messageBuffer, messageSize) {
  return new Promise(function(resolve, reject) {
    if (messageBuffer.offset >= messageSize) {
      resolve(messageBuffer);
    } else {
      rawReceive(id).then(function(report) {
        if (report == null || report.data == null) {
          reject("received no data from device");
        } else {
          messageBuffer.append(report.data);
          receiveMoreOfMessageBody(id, messageBuffer,
                                   messageSize).then(function(message) {
                                     resolve(message);
                                   });
        }
      });
    }
  });
}

var sendData = function(id, buffers) {
    
    return new Promise(function(resolve, reject) {
        
        var len = buffers.length;
        
        function _receive() {
            try {
                receive(id).then(function(c){
                    console.log("receive succ", c);
                    resolve(c);
                }, function(e) {
                    console.log("receive err",e)
                    reject(e);
                })
            } catch (e) {
                reject(e);
            }
        }
        
        function sendBuff(i) {
            if (i===len) {
                _receive()
            } else {
                var data = buffers[i];
                chrome.hid.send(id, REPORT_ID, data, function() {
                    if (chrome.runtime.lastError) {
                        reject(chrome.runtime.lastError);
                    } else {
                        sendBuff(i+1);
                    }
                });
            }
        }
        
        sendBuff(0);
        
    });
}

//-------

var handleDefault = function() {
    return Promise.resolve("unknown message type");
}

var handlePing = function() {
    return Promise.resolve("pong");
}

var handleEnumerate = jsonEnumerate;

var handleListen = function() {
    return jsonEnumerate().then(function(firstDevices) {
        var iterMax = 60;
        var iterDelay = 500;
        
        var firstStringified = JSON.stringify(firstDevices);
        
        return new Promise(function(resolve, reject){    
                
            var run = function(iteration) {
                
                if (iteration === iterMax) {
                    resolve(firstDevices);
                }
                jsonEnumerate().then(function(devices) {
                    var stringified = JSON.stringify(devices);
                    if (stringified !== firstStringified) {                        
                        resolve(devices);
                    } else {                        
                        window.setTimeout(run, iterDelay, iteration+1);
                    }
                }).catch(function(error) {
                    reject(error);
                });
            }
            
            window.setTimeout(run, iterDelay, 0);
        });
    });
}

var handleAcquire = function(id) {
    return new Promise(function(resolve, reject){
        try {
            chrome.hid.connect(id, function(connection) {
                if (typeof connection === "undefined") {
                    reject(chrome.runtime.lastError);
                } else {
                    connections[id]=connection.connectionId;
                    resolve({session: connection.connectionId});
                }
            });
        } catch(e) {
            reject(e);
        }
    });
}

var handleCall = function(body) {
    var id = body.id;
    var type = body.type;
    var message = body.message;
    var buffers = buildBuffers(type, message);
    return sendData(id, buffers);
}

var handleMessage = function(request, sender, sendResponse) {
    var responseFunction = handleDefault;
    console.log("Message arrived: ",request);
    
    if (request.type === "ping") {
        responseFunction = handlePing;
    }
    
    if (request.type === "enumerate") {
        responseFunction = handleEnumerate;
    }
    
    if (request.type === "listen") {
        responseFunction = handleListen;
    }
    
    if (request.type === "acquire") {
        responseFunction = handleAcquire;
    }
    
    if (request.type === "call") {
        responseFunction = handleCall;
    }
    
    responseFunction(request.body).then(function(responseBody){
        
        console.log("Response sent: ",responseBody);        
        sendResponse({type:"response", body: responseBody});
        
    }).catch(function(error){
        console.log("Error sent: ", error);
        
        sendResponse({type:"error", message: error.message || error});
        
    });
    
    // "return true" is necessary for asynchronous message passing,
    // don't remove it!
    return true; 
}

chrome.runtime.onMessageExternal.addListener(handleMessage);


module.exports = {"foo":"bar"};
