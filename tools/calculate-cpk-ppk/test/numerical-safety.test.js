import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeCapability} from '../src/domain/capability.js';
test('finite inputs that overflow must not return successful nonfinite capability',()=>{
 const result=analyzeCapability({measurements:[1e308,-1e308,1e308],lsl:-1e308,usl:1e308});assert.equal(result.ok,false);
});
