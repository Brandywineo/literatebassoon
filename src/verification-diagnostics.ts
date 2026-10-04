// Never retain remote free-text messages, echoed requests or verification codes.
export function verificationReason(data:unknown):string {
 const value=data as any;
 const candidates=[value?.code,value?.error_code,value?.error?.code,typeof value?.error==='string'?value.error:null,value?.message];
 const labels:Record<string,string>={incorrect_answer:'incorrect_answer','incorrect answer':'incorrect_answer',invalid_answer:'invalid_answer','invalid answer':'invalid_answer',verification_expired:'verification_expired','verification code expired':'verification_expired',invalid_verification_code:'invalid_verification_code','invalid verification code':'invalid_verification_code',verification_already_used:'verification_already_used','verification code already used':'verification_already_used',rate_limit_exceeded:'rate_limit_exceeded',account_suspended:'account_suspended'};
 for(const v of candidates)if(typeof v==='string'&&labels[v.trim().toLowerCase()])return labels[v.trim().toLowerCase()];
 return 'unclassified_rejection';
}
export class MoltbookVerificationError extends Error {
 httpStatus:number;reason:string;
 constructor(httpStatus:number,reason:string){super('moltbook_http_'+httpStatus);this.httpStatus=httpStatus;this.reason=reason;}
}
export function recordVerificationResponse(store:any,kind:string,id:string,status:number|null,reason:string){
 store.db.prepare('UPDATE social_verification_attempts SET http_status=?,response_reason=?,finished_at=? WHERE target=?').run(status,reason,Date.now(),kind+':'+id);
}
