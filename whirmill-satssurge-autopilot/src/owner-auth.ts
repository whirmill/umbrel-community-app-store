import { randomBytes } from 'node:crypto';

// Explicit bearer headers are scoped by browser origin (including port).
// Host cookies would also be sent to sibling Umbrel apps on other ports.
export class OwnerSessions {
  private sessions=new Map<string,number>();
  issue(at=Date.now()) {
    for(const [key,expires] of this.sessions)if(expires<=at)this.sessions.delete(key);
    if(this.sessions.size>=128)this.sessions.delete(this.sessions.keys().next().value!);
    const token=randomBytes(32).toString('hex');this.sessions.set(token,at+8*3600000);return token;
  }
  revoke(authorization:unknown) {
    if(typeof authorization==='string' && /^Bearer [a-f0-9]{64}$/.test(authorization))this.sessions.delete(authorization.slice(7));
  }
  accepts(authorization:unknown,at=Date.now()) {
    if(typeof authorization!=='string'||!/^Bearer [a-f0-9]{64}$/.test(authorization))return false;
    const token=authorization.slice(7),expires=this.sessions.get(token);
    if(expires===undefined)return false;
    if(expires<=at){this.sessions.delete(token);return false;}
    return true;
  }
}
