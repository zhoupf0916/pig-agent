// Small acceptance-only load balancer; production continues to use Nginx.
import http from 'node:http';
let n=0;
http.createServer((req,res)=>{
 const upstream=http.request({hostname:++n%2?'cloud-a':'cloud-b',port:8890,path:req.url,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
 upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('upstream unavailable');});
 res.on('close',()=>upstream.destroy());req.pipe(upstream);
}).listen(8890,'0.0.0.0');
