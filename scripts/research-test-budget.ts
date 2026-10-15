import {openStore} from '../src/store.ts';
import {grantResearchTestAllowance} from '../src/research.ts';
const store=openStore(process.env.DATA_DIR||'./data');
try{const s=grantResearchTestAllowance(store);console.log(JSON.stringify({test_attempts_remaining:s.test_attempts_remaining,expires_at:s.test_allowance_expires_at,next_eligible_at:s.next_eligible_at},null,2));}finally{store.db.close();}
