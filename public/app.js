/* dashboard UI: site switcher, mobile menu, line charts */
(function(){
  var btn=document.getElementById("switchBtn"),pop=document.getElementById("switchPop");
  if(btn&&pop){var q=pop.querySelector(".switch-q");
    btn.addEventListener("click",function(){var o=pop.hidden;pop.hidden=!o;btn.setAttribute("aria-expanded",String(o));if(o)setTimeout(function(){q.focus();},10);});
    document.addEventListener("click",function(e){if(!pop.hidden&&!e.target.closest(".switch"))pop.hidden=true;});
    document.addEventListener("keydown",function(e){if(e.key==="Escape"&&!pop.hidden){pop.hidden=true;btn.focus();}});
    q.addEventListener("input",function(){var f=q.value.toLowerCase();pop.querySelectorAll(".switch-list a[data-name]").forEach(function(a){a.style.display=a.getAttribute("data-name").toLowerCase().indexOf(f)>-1?"":"none";});});
    q.addEventListener("keydown",function(e){if(e.key==="Enter"){var f=pop.querySelector('.switch-list a[data-name]:not([style*="none"])');if(f)location.href=f.href;}});}
  var bg=document.getElementById("burger"),side=document.querySelector(".side");
  if(bg&&side){bg.addEventListener("click",function(){side.classList.toggle("open");});document.addEventListener("click",function(e){if(side.classList.contains("open")&&!e.target.closest(".side")&&!e.target.closest("#burger"))side.classList.remove("open");});}
  function n(v){return Number(v||0).toLocaleString("en-US");}
  document.querySelectorAll(".viz[data-line]").forEach(function(host){
    var series=JSON.parse(host.getAttribute("data-line")),cls=host.getAttribute("data-cls")||"";
    if(!series.length){host.innerHTML='<p class="empty">No data yet.</p>';return;}
    var W=600,H=200,pl=38,pr=8,pt=12,pb=24,max=Math.max.apply(null,series.map(function(s){return s.v;}))||1;
    var x=function(i){return pl+(series.length===1?0:i*(W-pl-pr)/(series.length-1));},y=function(v){return pt+(H-pt-pb)*(1-v/max);};
    var pts=series.map(function(s,i){return [x(i),y(s.v)];});
    var path="M"+pts.map(function(p){return p[0].toFixed(1)+" "+p[1].toFixed(1);}).join("L"),area=path+"L"+pts[pts.length-1][0].toFixed(1)+" "+(H-pb)+"L"+pts[0][0].toFixed(1)+" "+(H-pb)+"Z";
    var ticks=[0,.5,1].map(function(f){return '<line class="ax" x1="'+pl+'" x2="'+(W-pr)+'" y1="'+y(max*f)+'" y2="'+y(max*f)+'"/><text class="lbl" x="'+(pl-6)+'" y="'+(y(max*f)+4)+'" text-anchor="end">'+n(Math.round(max*f))+'</text>';}).join("");
    var step=Math.max(1,Math.round(series.length/6));
    var xl=series.map(function(s,i){return i%step===0?'<text class="lbl" x="'+x(i)+'" y="'+(H-6)+'" text-anchor="middle">'+s.k.slice(5)+'</text>':"";}).join("");
    host.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" role="img">'+ticks+'<path class="ar '+cls+'" d="'+area+'"/><path class="ln '+cls+'" d="'+path+'"/><line class="xh" y1="'+pt+'" y2="'+(H-pb)+'"/>'+pts.map(function(p,i){return '<circle class="dot '+cls+'" cx="'+p[0]+'" cy="'+p[1]+'" r="4"/>';}).join("")+xl+'<rect class="hit" x="'+pl+'" y="0" width="'+(W-pl-pr)+'" height="'+H+'"/></svg><div class="tip"></div>';
    var svg=host.querySelector("svg"),tip=host.querySelector(".tip"),xh=host.querySelector(".xh"),dots=host.querySelectorAll(".dot");
    svg.addEventListener("mousemove",function(e){var r=svg.getBoundingClientRect(),mx=(e.clientX-r.left)/r.width*W,i=0,bd=1e9;pts.forEach(function(p,k){var d=Math.abs(p[0]-mx);if(d<bd){bd=d;i=k;}});
      dots.forEach(function(d,k){d.classList.toggle("on",k===i);});xh.setAttribute("x1",pts[i][0]);xh.setAttribute("x2",pts[i][0]);xh.classList.add("on");tip.textContent=series[i].k+": "+n(series[i].v);tip.style.left=(pts[i][0]/W*r.width)+"px";tip.style.top=(pts[i][1]/H*r.height)+"px";tip.classList.add("on");});
    svg.addEventListener("mouseleave",function(){dots.forEach(function(d){d.classList.remove("on");});xh.classList.remove("on");tip.classList.remove("on");});
  });
})();

/* live sync progress bar (Sync & Deploy) */
(function(){
  var el=document.getElementById("syncProg"); if(!el||el.dataset.done==="1") return;
  var step=el.querySelector("[data-step]"),pct=el.querySelector("[data-pct]"),bar=el.querySelector("[data-bar]"),det=el.querySelector("[data-detail]");
  function tick(){
    fetch(el.dataset.status,{credentials:"same-origin"}).then(function(r){return r.json();}).then(function(j){
      if(j.idle){ location.reload(); return; }
      step.textContent=j.step; pct.textContent=j.pct+"%"; bar.style.width=j.pct+"%"; det.textContent=j.detail||"";
      if(j.done){ el.className="progress "+(j.error?"bad":"ok"); setTimeout(function(){ location.reload(); },1200); return; }
      setTimeout(tick,1200);
    }).catch(function(){ setTimeout(tick,3000); });
  }
  setTimeout(tick,800);
})();
