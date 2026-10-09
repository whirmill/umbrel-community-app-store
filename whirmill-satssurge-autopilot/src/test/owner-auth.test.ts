import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OwnerSessions} from '../owner-auth.js';

test('owner sessions require explicit bearer authorization and expire without cookie fallback',()=>{
  const sessions=new OwnerSessions(),token=sessions.issue(1000);
  assert.equal(sessions.accepts('Bearer '+token,1001),true);
  for(const header of [undefined,'satssurge='+token,token,'Bearer '+token+' extra','Basic '+token])assert.equal(sessions.accepts(header,1001),false);
  assert.equal(sessions.accepts('Bearer '+token,1000+8*3600000),false);
  assert.equal(new OwnerSessions().accepts('Bearer '+token,1001),false);
});
