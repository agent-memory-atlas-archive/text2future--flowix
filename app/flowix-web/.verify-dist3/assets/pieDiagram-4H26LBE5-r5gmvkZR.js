import{bx as R,aa as K,bf as Q,ab as Y,bg as tt,ag as et,bj as at,d,aN as W,ad as rt,u as nt,bd as it,aV as st,G as ot,v as lt,$ as ct}from"./Middleware-DN3SEAXV.js";import{p as ut}from"./chunk-4BX2VUAB-ChJU6tQE.js";import{p as dt}from"./wardley-L42UT6IY-NFk7morI.js";import{e as S,a as pt}from"./transform-B0oYUMRy.js";import{d as I}from"./arc-CQBEB0IC.js";import{o as gt}from"./ordinal-Cboi1Yqb.js";import"./index-Ds2nF888.js";import"./init-Gi6I4Gst.js";function ft(t,a){return a<t?-1:a>t?1:a>=t?0:NaN}function ht(t){return t}function mt(){var t=ht,a=ft,f=null,y=S(0),s=S(R),p=S(0);function o(e){var n,l=(e=pt(e)).length,g,h,v=0,c=new Array(l),i=new Array(l),x=+y.apply(this,arguments),w=Math.min(R,Math.max(-R,s.apply(this,arguments)-x)),m,D=Math.min(Math.abs(w)/l,p.apply(this,arguments)),$=D*(w<0?-1:1),u;for(n=0;n<l;++n)(u=i[c[n]=n]=+t(e[n],n,e))>0&&(v+=u);for(a!=null?c.sort(function(A,C){return a(i[A],i[C])}):f!=null&&c.sort(function(A,C){return f(e[A],e[C])}),n=0,h=v?(w-l*$)/v:0;n<l;++n,x=m)g=c[n],u=i[g],m=x+(u>0?u*h:0)+$,i[g]={data:e[g],index:n,value:u,startAngle:x,endAngle:m,padAngle:D};return i}return o.value=function(e){return arguments.length?(t=typeof e=="function"?e:S(+e),o):t},o.sortValues=function(e){return arguments.length?(a=e,f=null,o):a},o.sort=function(e){return arguments.length?(f=e,a=null,o):f},o.startAngle=function(e){return arguments.length?(y=typeof e=="function"?e:S(+e),o):y},o.endAngle=function(e){return arguments.length?(s=typeof e=="function"?e:S(+e),o):s},o.padAngle=function(e){return arguments.length?(p=typeof e=="function"?e:S(+e),o):p},o}var vt=ct.pie,z={sections:new Map,showData:!1},T=z.sections,F=z.showData,xt=structuredClone(vt),St=d(()=>structuredClone(xt),"getConfig"),yt=d(()=>{T=new Map,F=z.showData,lt()},"clear"),wt=d(({label:t,value:a})=>{if(a<0)throw new Error(`"${t}" has invalid value: ${a}. Negative values are not allowed in pie charts. All slice values must be >= 0.`);T.has(t)||(T.set(t,a),W.debug(`added new section: ${t}, with value: ${a}`))},"addSection"),At=d(()=>T,"getSections"),Ct=d(t=>{F=t},"setShowData"),Dt=d(()=>F,"getShowData"),_={getConfig:St,clear:yt,setDiagramTitle:at,getDiagramTitle:et,setAccTitle:tt,getAccTitle:Y,setAccDescription:Q,getAccDescription:K,addSection:wt,getSections:At,setShowData:Ct,getShowData:Dt},$t=d((t,a)=>{ut(t,a),a.setShowData(t.showData),t.sections.map(a.addSection)},"populateDb"),Tt={parse:d(async t=>{const a=await dt("pie",t);W.debug(a),$t(a,_)},"parse")},bt=d(t=>`
  .pieCircle{
    stroke: ${t.pieStrokeColor};
    stroke-width : ${t.pieStrokeWidth};
    opacity : ${t.pieOpacity};
  }
  .pieOuterCircle{
    stroke: ${t.pieOuterStrokeColor};
    stroke-width: ${t.pieOuterStrokeWidth};
    fill: none;
  }
  .pieTitleText {
    text-anchor: middle;
    font-size: ${t.pieTitleTextSize};
    fill: ${t.pieTitleTextColor};
    font-family: ${t.fontFamily};
  }
  .slice {
    font-family: ${t.fontFamily};
    fill: ${t.pieSectionTextColor};
    font-size:${t.pieSectionTextSize};
    // fill: white;
  }
  .legend text {
    fill: ${t.pieLegendTextColor};
    font-family: ${t.fontFamily};
    font-size: ${t.pieLegendTextSize};
  }
`,"getStyles"),kt=bt,Et=d(t=>{const a=[...t.values()].reduce((s,p)=>s+p,0),f=[...t.entries()].map(([s,p])=>({label:s,value:p})).filter(s=>s.value/a*100>=1);return mt().value(s=>s.value).sort(null)(f)},"createPieArcs"),Mt=d((t,a,f,y)=>{W.debug(`rendering pie chart
`+t);const s=y.db,p=rt(),o=nt(s.getConfig(),p.pie),e=40,n=18,l=4,g=450,h=g,v=it(a),c=v.append("g");c.attr("transform","translate("+h/2+","+g/2+")");const{themeVariables:i}=p;let[x]=st(i.pieOuterStrokeWidth);x??=2;const w=o.textPosition,m=Math.min(h,g)/2-e,D=I().innerRadius(0).outerRadius(m),$=I().innerRadius(m*w).outerRadius(m*w);c.append("circle").attr("cx",0).attr("cy",0).attr("r",m+x/2).attr("class","pieOuterCircle");const u=s.getSections(),A=Et(u),C=[i.pie1,i.pie2,i.pie3,i.pie4,i.pie5,i.pie6,i.pie7,i.pie8,i.pie9,i.pie10,i.pie11,i.pie12];let b=0;u.forEach(r=>{b+=r});const G=A.filter(r=>(r.data.value/b*100).toFixed(0)!=="0"),k=gt(C).domain([...u.keys()]);c.selectAll("mySlices").data(G).enter().append("path").attr("d",D).attr("fill",r=>k(r.data.label)).attr("class","pieCircle"),c.selectAll("mySlices").data(G).enter().append("text").text(r=>(r.data.value/b*100).toFixed(0)+"%").attr("transform",r=>"translate("+$.centroid(r)+")").style("text-anchor","middle").attr("class","slice");const V=c.append("text").text(s.getDiagramTitle()).attr("x",0).attr("y",-400/2).attr("class","pieTitleText"),N=[...u.entries()].map(([r,M])=>({label:r,value:M})),E=c.selectAll(".legend").data(N).enter().append("g").attr("class","legend").attr("transform",(r,M)=>{const P=n+l,q=P*N.length/2,H=12*n,J=M*P-q;return"translate("+H+","+J+")"});E.append("rect").attr("width",n).attr("height",n).style("fill",r=>k(r.label)).style("stroke",r=>k(r.label)),E.append("text").attr("x",n+l).attr("y",n-l).text(r=>s.getShowData()?`${r.label} [${r.value}]`:r.label);const j=Math.max(...E.selectAll("text").nodes().map(r=>r?.getBoundingClientRect().width??0)),U=h+e+n+l+j,L=V.node()?.getBoundingClientRect().width??0,X=h/2-L/2,Z=h/2+L/2,B=Math.min(0,X),O=Math.max(U,Z)-B;v.attr("viewBox",`${B} 0 ${O} ${g}`),ot(v,g,O,o.useMaxWidth)},"draw"),Rt={draw:Mt},It={parser:Tt,db:_,renderer:Rt,styles:kt};export{It as diagram};
