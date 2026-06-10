import http from 'http';

console.log("=========================================");
console.log("Perf server listening on 8081.");
console.log("Waiting for user interaction...");
console.log("=========================================");

let i = 0;
http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk.toString());
  req.on('end', () => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end('ok');
    if (body) {
      try {
          const d = JSON.parse(body);
          console.log(`FPS: ${String(d.fps).padStart(3, ' ')} | Tiles: ${String(d.tiles).padStart(3, ' ')} | Total: ${d.totalFrame}ms | getTiles: ${d.getVisibleTiles}ms | updateGPU: ${d.updateTiles}ms | cam: ${d.updateCam}ms | render: ${d.render}ms`);
      } catch (e) {
          console.log(body);
      }
    }
  });
}).listen(8081);
