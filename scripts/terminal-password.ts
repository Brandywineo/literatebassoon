export async function terminalPassword(prompt:string){
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('Run this wallet tool interactively in your own terminal');
 process.stdout.write(prompt);process.stdin.setRawMode(true);process.stdin.resume();
 return await new Promise<string>((resolve,reject)=>{let value='';
 const done=(error?:Error)=>{process.stdin.off('data',onData);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');if(error)reject(error);else resolve(value);};
 const onData=(chunk:Buffer)=>{for(const char of chunk.toString('utf8')){if(char==='\u0003'){done(Error('Cancelled'));return;}if(char==='\r'||char==='\n'){done();return;}if(char==='\u007f'||char==='\b')value=value.slice(0,-1);else if(char>=' ')value+=char;}};
 process.stdin.on('data',onData);});
}
