// The placeholder bee: a simple mark shown wherever a bee has no portrait of its own yet. The original three bees'
// art belongs to the official bees and is never used for an owner's bee.

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
<rect width="120" height="120" rx="18" fill="#13121a"/>
<g fill="none" stroke="#c98500" stroke-width="3.5" stroke-linecap="round">
<path d="M52 34c-4-9-11-13-17-12"/><path d="M68 34c4-9 11-13 17-12"/>
</g>
<circle cx="35" cy="22" r="4" fill="#c98500"/><circle cx="85" cy="22" r="4" fill="#c98500"/>
<ellipse cx="38" cy="58" rx="20" ry="13" transform="rotate(-25 38 58)" fill="#9085e9" fill-opacity=".28" stroke="#9085e9" stroke-width="2.5"/>
<ellipse cx="82" cy="58" rx="20" ry="13" transform="rotate(25 82 58)" fill="#9085e9" fill-opacity=".28" stroke="#9085e9" stroke-width="2.5"/>
<clipPath id="b"><ellipse cx="60" cy="70" rx="19" ry="27"/></clipPath>
<ellipse cx="60" cy="70" rx="19" ry="27" fill="#c98500"/>
<g clip-path="url(#b)" fill="#13121a"><rect x="38" y="58" width="44" height="7"/><rect x="38" y="71" width="44" height="7"/><rect x="38" y="84" width="44" height="7"/></g>
<circle cx="60" cy="42" r="12" fill="#c98500"/>
<circle cx="55.5" cy="41" r="2.4" fill="#13121a"/><circle cx="64.5" cy="41" r="2.4" fill="#13121a"/>
<path d="M60 97l-3.5 7h7z" fill="#c98500"/>
</svg>`;

/** Usable anywhere an image URL is (the page's CSP allows data: images). */
export const BEE_MARK_URL = `data:image/svg+xml,${encodeURIComponent(SVG)}`;
