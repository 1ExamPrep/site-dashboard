/* Site tracker. <script src="https://YOUR-DASHBOARD/t.js" data-site="sk_…" defer></script>
   Sends page views and clicks to the dashboard. No cookies: a per-tab session id only. Exposes window.dash.track(name, params). */
(function(){
  var s=document.currentScript||document.querySelector('script[data-site]'); if(!s) return;
  var KEY=s.getAttribute("data-site"), URL=s.src.replace(/\/t\.js.*$/,"")+"/t";
  var sid; try{sid=sessionStorage.getItem("_dsid");if(!sid){sid=Math.random().toString(36).slice(2)+Date.now().toString(36);sessionStorage.setItem("_dsid",sid);}}catch(e){sid=Math.random().toString(36).slice(2);}
  var queue=[],timer;
  function flush(){ if(!queue.length) return; var body=JSON.stringify({k:KEY,e:queue.splice(0,20)});
    try{ if(navigator.sendBeacon){ navigator.sendBeacon(URL,new Blob([body],{type:"text/plain"})); return; } }catch(e){}
    try{ fetch(URL,{method:"POST",body:body,headers:{"Content-Type":"text/plain"},keepalive:true,mode:"cors"}); }catch(e){} }
  function track(name,params){ queue.push({n:name,p:params||{},u:location.pathname,r:document.referrer||"",s:sid}); clearTimeout(timer); timer=setTimeout(flush,400); }
  window.dash={track:track,flush:flush};
  track("page_view",{title:document.title.slice(0,80)});
  /* generic clicks for sites that do not have their own tracking script */
  if(!window.__dashCustom){
    document.addEventListener("click",function(e){ var a=e.target.closest("a,button"); if(!a) return; var h=a.getAttribute("href")||"";
      var m=h.match(/\/cart\/(\d+):/); if(m){ track("buy_now_click",{variant_id:m[1],button_location:a.getAttribute("data-track")||"link"}); return; }
      if(/^tel:/.test(h)){ track("phone_click",{}); return; }
      if(a.hasAttribute("data-track")){ track(a.getAttribute("data-track"),{}); } },true);
  }
  document.addEventListener("visibilitychange",function(){ if(document.visibilityState==="hidden") flush(); });
  window.addEventListener("pagehide",flush);
})();
