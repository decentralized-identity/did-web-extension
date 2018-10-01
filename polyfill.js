
(function(){

  /* Helper Functions */
  
    function uuid() { // IETF RFC 4122, version 4
      var d = new Date().getTime();
      if (typeof performance !== 'undefined' && typeof performance.now === 'function'){
          d += performance.now(); //use high-precision timer if available
      }
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
          var r = (d + Math.random() * 16) % 16 | 0;
          d = Math.floor(d / 16);
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    }
  
    async function hashTransaction(message) {
      const msgBuffer = new TextEncoder('utf-8').encode(message);
      const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => ('00' + b.toString(16)).slice(-2)).join(''); // convert to hex
    }
  
  /* Navigator.prototype.did */
  
    if (!navigator.did) {
    
      const RESOLVER_ENDPOINT = '/1.0/identifiers/';
  
      class DIDResult {
        constructor (did, src){
          this.did = did;
          this.resolverData = src;
          this.document = src.didDocument;
          this.services = {};
          if (this.document.service) {
            // Spec technically allows for an object, which this normalizes
            (Array.isArray(this.document.service) ? this.document.service : [this.document.service]).forEach(s => {
              (this.services[s.type] || (this.services[s.type] = [])).push(s);
            });
          }
        }
      }
  
      Navigator.prototype.did = {
        async lookup (did){
          return fetch(RESOLVER_ENDPOINT + did)
            .then(response => response.json())
            .then(json => result = new DIDResult(did, json))
            .catch(e => console.log(e));
        },
        async requestIdentifier (){
          var did = (prompt('Please enter a DID') || '').trim()
          if (did.match('did:')) return did;
          throw 'No DID provided';
        }
      }
      console.log(navigator.did);
    }
  
  /* IdentityHub Classes */
  
  if (!('IdentityHubManager' in window)) {
  
      window.IdentityHubManager = class IdentityHubManager {
        constructor (DIDResult, options = {}){
          this.result = DIDResult;
          this.did = DIDResult.did;
          this.sender = options.sender;
          this.sign = options.sign;
          this.encrypt = options.encrypt;
          this.decrypt = options.decrypt;
          resolveInstances(this, DIDResult);
        }
        ready(){
          return this._ready;
        }
        refresh (){
          return navigator.did.lookup(this.did)
            .then(result => resolveInstances(this, result))
            .catch(e => console.error('Refresh of DIDResult cache failed'))
        }
        transact (op, props){
          if (props) {
            props.did = this.did;
            props.sender = this.sender;
          }
          var txn = op instanceof IdentityHubTransaction ? op : new IdentityHubTransaction(op, props);
          console.log(txn);
          // if (!this.keys) {
          //   return reject('There are no Identity Hub encryption key specified for ' + this.did);
          // }
  
          this.ready().then(async () => {
            //var last = this.instances[this.instances.length - 1];
            for (let instance of this.instances) {
              var exit = await fetch(instance.endpoint, {
                  method: 'POST',
                  mode: 'cors',
                  body: JSON.stringify(await txn.message())
                }).then(response => {
                  if (response.ok) { // This should be based on a Hub payload error msg, not reliant on HTTP-specific errors
                    console.log(response);
                    txn.response = response;
                  }
                  return response.ok;
                }).catch(e => {
                  if (e) console.log(e);
                  return false;
                });
              console.log(exit);
              if (exit) break;
            }
  
          }).catch(e => {
            console.log(e);
          });
  
          return txn;
        }
        getProfile(){
          return new Promise(resolve => {
            setTimeout(function(){
              resolve({
                '@type': 'Profile/Response',
                'payload': [{
                  "@context": "http://schema.org",
                  "@type": "Person",
                  "name": "Alice Smith",
                  "description": "New grad looking for a software engineering gig.",
                  "image": [
                    {
                      "@type": "ImageObject",
                      "name": "profile",
                      "url": "https://i.imgur.com/NJ0nl20.jpg"
                    },
                    {
                      "@type": "ImageObject",
                      "name": "hero",
                      "url": "https://i.imgur.com/Ve2NdVY.jpg"
                    }
                  ],
                  "website": [
                    {
                      "@type": "WebSite",
                      "url": "https://github.com/alice-bobbins"
                    }
                  ]
                }]
              })
            }, ~~(Math.random() * (2000 - 1000 + 1) + 1000));
          })
        }
      }

      function resolveInstances(target, result){
        var hub = (result.services.IdentityHub || [])[0];
        var instances = hub && hub.serviceEndpoint && hub.serviceEndpoint.instances;
        target._ready = new Promise((resolve, reject) => {
          var count = instances && instances.length;
          if (!count) {
            return reject('There are no Identity Hub instances specified for ' + target.did);
          }
          target.keys = {};
          var keyIDs = Array.from(hub.publicKey);
          Array.from(result.document.publicKey).forEach(desc => {
            if (keyIDs.includes(desc.id)) target.keys[desc.id] = desc;
          });
          target.instances = instances.map(did => {
            var instance = new IdentityHubInstance(did);
            instance.ready().then(() => resolve()).catch(e => {
              --count;
              if (!count) reject('No Identity Hub instances can be resolved.')
            });
            return instance;
          });
        });
      }
  
      window.IdentityHubInstance = class IdentityHubInstance {
        constructor (did){
          if (!did.match(/^did:/)) throw new Error('Invalid DID')
          this.did = did;
          this.endpoint = null;
          this.resolve();
        }
        resolve(){
          this.status = 'resolving';
          return this._ready = new Promise((resolve, reject) => {
            navigator.did.lookup(this.did).then(result => {
              let host = Array.from(result.services.IdentityHubHost)[0];
              if (host) {
                this.keys = {};
                var keyIDs = Array.from(host.publicKey);
                Array.from(result.document.publicKey).forEach(desc => {
                  if (keyIDs.includes(desc.id)) this.keys[desc.id] = desc;
                });
                this.endpoint = host.serviceEndpoint;
                this.status = 'resolved';
                return resolve();
              }
              else {
                this.status = 'unresolved';
                reject(new Error('No IdentityHubHost descriptor found'));
              }
            }).catch(e => {
              this.status = 'unresolved';
              reject(e);
            })
          });
        }
        ready (){
          return this._ready;
        }
      }
  
      function encryptHubMessage(msg, key){
        
      }
  
      window.IdentityHubTransaction = class IdentityHubTransaction {
        constructor (op, props){
          this.op = op.toLowerCase();
          var activity = this.op.split('/')[1];
          var payload = props.body.payload;
          switch (activity) {
            case 'create':
              if (props.isolate !== false) {
                if (!payload) throw new Error('No payload found. Create operations require a payload.');
                // This inferes that once cast, the UUID must remain an immutable value, else the hash ID won't match
                (payload.meta = payload.meta || {}).uuid = uuid();
              }
              break;
            case 'update':
              // Updates must have IDs
              if (!payload.meta.id) {
                throw new Error('Update operations require specification of an ID.');
              }
              break;
          }
          this._message = Object.assign({
            iss: props.sender,
            aud: props.did,
            '@type': this.op,
          }, props.body);
        }
        async message (){
          await this.id();
          return this._message;
        }
        async id (){
          var meta = this._message.payload.meta;
          return meta.id || (meta.id = await hashTransaction(this._message.payload));
        }
      }
  }
  
  })()