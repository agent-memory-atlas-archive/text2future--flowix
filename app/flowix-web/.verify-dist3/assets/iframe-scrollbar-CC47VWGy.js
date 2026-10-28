function n(r){return`
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: ${r}; border-radius: 3px; }
    * { scrollbar-width: thin; scrollbar-color: ${r} transparent; }
  `}function l(r){if(!(!r||document.documentElement.dataset.platform!=="non-mac"))try{const t=r.contentDocument;if(!t?.head||t.getElementById("flowix-iframe-scrollbar"))return;const o=getComputedStyle(document.documentElement).getPropertyValue("--muted-foreground").trim();if(!o)return;const a=t.createElement("style");a.id="flowix-iframe-scrollbar",a.textContent=n(`color-mix(in oklch, ${o} 30%, transparent)`),t.head.append(a)}catch{}}function e(r,t){const o=`color-mix(in oklch, ${r} ${t?78:34}%, transparent)`;return`
    * { scrollbar-width: ${t?"auto":"thin"} !important; scrollbar-color: ${t?"auto":"transparent transparent"} !important; }
    ::-webkit-scrollbar { width: 6px !important; height: 6px !important; }
    ::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent !important; }
    ::-webkit-scrollbar-thumb { background: transparent !important; border-radius: 999px !important; }
    [data-flowix-html-scrolling="true"] { scrollbar-color: ${t?"auto":`${o} transparent`} !important; }
    [data-flowix-html-scrolling="true"]::-webkit-scrollbar-thumb { background: ${o} !important; }
    [data-flowix-html-scrolling="true"]::-webkit-scrollbar-thumb:hover { background: ${r} !important; }
  `}export{n as i,e as l,l as s};
