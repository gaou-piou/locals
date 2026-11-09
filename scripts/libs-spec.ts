/**
 * What `pnpm libs:expand` should try to bundle. Nothing here is trusted: the tool downloads every
 * (version, CDN URL) pair and keeps only those whose bytes equal the npm file (SRI-safe).
 * A wrong guess here costs a 404, never a wrong redirect.
 */
export type FileSpec = {
  /** Path inside the npm tarball. */
  path: string;
  type: "script" | "stylesheet" | "font" | "image";
  /** Path below `<cdnjs name>/{version}/` on cdnjs and its mirrors. Omit when cdnjs ships another build. */
  cdnjs?: string;
  /** Extra full URL templates (`https://host/...{version}...`) serving the same file. */
  hosts?: string[];
  /** Kept for every bundled version even if no CDN URL points at it (fonts and images a bundled CSS file uses). */
  companion?: boolean;
};

export type LibSpec = {
  name: string;
  npm: string;
  /** Directory name on cdnjs (and mirrors) when it differs from `name`. */
  cdnjs?: string;
  files: FileSpec[];
  /** Cap on bundled versions per library (newest kept; thinned to the last patch of each minor when exceeded). */
  max?: number;
  /** Lowest version worth bundling. */
  since?: string;
  /** Only versions matching this predicate are tried (e.g. one major). */
  only?: RegExp;
};

/** cdnjs and the mirrors that copy its tree verbatim. */
export const CDNJS_MIRRORS = [
  "https://cdnjs.cloudflare.com/ajax/libs",
  "https://cdn.bootcdn.net/ajax/libs",
  "https://cdn.staticfile.org",
  "https://lib.baomitu.com",
] as const;

const s = (path: string, o: Partial<FileSpec> = {}): FileSpec => ({ path, type: "script", ...o });
const c = (path: string, o: Partial<FileSpec> = {}): FileSpec => ({ path, type: "stylesheet", ...o });
const f = (path: string, o: Partial<FileSpec> = {}): FileSpec => ({ path, type: "font", companion: true, ...o });
/** An image a bundled stylesheet loads; it is only made web-accessible, never redirected to. */
const img = (...paths: string[]): FileSpec[] => paths.map((path) => ({ path, type: "image", companion: true }));

const BS_CDN = ["stackpath.bootstrapcdn.com", "maxcdn.bootstrapcdn.com", "netdna.bootstrapcdn.com"];
const bootstrapcdn = (rest: string) => BS_CDN.map((h) => `https://${h}/${rest}`);
const angularMod = (m: string): LibSpec => ({
  name: `angular-${m}`,
  npm: `angular-${m}`,
  cdnjs: "angular.js",
  max: 40,
  files: [
    s(`angular-${m}.min.js`, {
      cdnjs: `angular-${m}.min.js`,
      hosts: [`https://ajax.googleapis.com/ajax/libs/angularjs/{version}/angular-${m}.min.js`],
    }),
  ],
});

export const SPEC: LibSpec[] = [
  // ── already shipped: more versions, more hosts ─────────────────────────────────────────────
  {
    name: "jquery",
    npm: "jquery",
    max: 60,
    since: "1.7.0",
    files: [
      s("dist/jquery.min.js", {
        cdnjs: "jquery.min.js",
        hosts: [
          "https://code.jquery.com/jquery-{version}.min.js",
          "https://ajax.googleapis.com/ajax/libs/jquery/{version}/jquery.min.js",
          "https://ajax.aspnetcdn.com/ajax/jQuery/jquery-{version}.min.js",
          "https://ajax.aspnetcdn.com/ajax/jquery/jquery-{version}.min.js",
          "https://ajax.microsoft.com/ajax/jquery/jquery-{version}.min.js",
        ],
      }),
    ],
  },
  {
    name: "bootstrap",
    npm: "bootstrap",
    cdnjs: "twitter-bootstrap",
    max: 40,
    since: "3.0.0",
    files: [
      c("dist/css/bootstrap.min.css", { cdnjs: "css/bootstrap.min.css", hosts: bootstrapcdn("bootstrap/{version}/css/bootstrap.min.css") }),
      s("dist/js/bootstrap.min.js", { cdnjs: "js/bootstrap.min.js", hosts: [...bootstrapcdn("bootstrap/{version}/js/bootstrap.min.js"), "https://ajax.aspnetcdn.com/ajax/bootstrap/{version}/bootstrap.min.js"] }),
      s("dist/js/bootstrap.bundle.min.js", { cdnjs: "js/bootstrap.bundle.min.js", hosts: bootstrapcdn("bootstrap/{version}/js/bootstrap.bundle.min.js") }),
      f("dist/fonts/glyphicons-halflings-regular.woff2", { cdnjs: "fonts/glyphicons-halflings-regular.woff2", hosts: bootstrapcdn("bootstrap/{version}/fonts/glyphicons-halflings-regular.woff2") }),
      // 3.1/3.2 ship no woff2; kept only for those (keptFiles).
      f("dist/fonts/glyphicons-halflings-regular.woff", { cdnjs: "fonts/glyphicons-halflings-regular.woff", hosts: bootstrapcdn("bootstrap/{version}/fonts/glyphicons-halflings-regular.woff") }),
    ],
  },
  {
    name: "fontawesome",
    npm: "@fortawesome/fontawesome-free",
    cdnjs: "font-awesome",
    max: 25,
    since: "5.0.0",
    files: [
      c("css/all.min.css", { cdnjs: "css/all.min.css" }),
      c("css/all.css", { hosts: ["https://use.fontawesome.com/releases/v{version}/css/all.css"] }),
      f("webfonts/fa-solid-900.woff2", { cdnjs: "webfonts/fa-solid-900.woff2", hosts: ["https://use.fontawesome.com/releases/v{version}/webfonts/fa-solid-900.woff2"] }),
      f("webfonts/fa-regular-400.woff2", { cdnjs: "webfonts/fa-regular-400.woff2", hosts: ["https://use.fontawesome.com/releases/v{version}/webfonts/fa-regular-400.woff2"] }),
      f("webfonts/fa-brands-400.woff2", { cdnjs: "webfonts/fa-brands-400.woff2", hosts: ["https://use.fontawesome.com/releases/v{version}/webfonts/fa-brands-400.woff2"] }),
      // 6.x: the v4 shim icons (`fa fa-*` in the FontAwesome family) render from this face.
      f("webfonts/fa-v4compatibility.woff2", { cdnjs: "webfonts/fa-v4compatibility.woff2", hosts: ["https://use.fontawesome.com/releases/v{version}/webfonts/fa-v4compatibility.woff2"] }),
    ],
  },
  { name: "jquery-ui", npm: "jquery-ui", cdnjs: "jqueryui", max: 25, since: "1.10.0", files: [s("dist/jquery-ui.min.js", { cdnjs: "jquery-ui.min.js", hosts: ["https://code.jquery.com/ui/{version}/jquery-ui.min.js", "https://ajax.googleapis.com/ajax/libs/jqueryui/{version}/jquery-ui.min.js"] })] },
  { name: "popperjs-core", npm: "@popperjs/core", cdnjs: "popper.js", max: 25, files: [s("dist/umd/popper.min.js", { cdnjs: "umd/popper.min.js" })] },
  { name: "axios", npm: "axios", max: 20, since: "0.18.0", files: [s("dist/axios.min.js", { cdnjs: "axios.min.js" })] },
  { name: "moment", npm: "moment", cdnjs: "moment.js", max: 15, files: [s("min/moment.min.js", { cdnjs: "moment.min.js" })] },
  { name: "lodash", npm: "lodash", cdnjs: "lodash.js", max: 30, since: "4.0.0", files: [s("lodash.min.js", { cdnjs: "lodash.min.js" })] },
  { name: "underscore", npm: "underscore", cdnjs: "underscore.js", max: 15, files: [s("underscore-min.js", { cdnjs: "underscore-min.js" })] },
  { name: "d3", npm: "d3", max: 12, since: "4.0.0", files: [s("dist/d3.min.js", { cdnjs: "d3.min.js" })] },
  { name: "chartjs", npm: "chart.js", cdnjs: "Chart.js", max: 15, since: "3.0.0", files: [s("dist/chart.umd.js", { cdnjs: "chart.umd.js" }), s("dist/chart.min.js", { cdnjs: "chart.min.js" })] },
  { name: "vue", npm: "vue", max: 15, since: "3.0.0", files: [s("dist/vue.global.prod.js", { cdnjs: "vue.global.prod.min.js" })] },
  { name: "react", npm: "react", max: 20, since: "16.0.0", files: [s("umd/react.production.min.js", { cdnjs: "umd/react.production.min.js" })] },
  { name: "react-dom", npm: "react-dom", max: 20, since: "16.0.0", files: [s("umd/react-dom.production.min.js", { cdnjs: "umd/react-dom.production.min.js" })] },
  { name: "sweetalert2", npm: "sweetalert2", cdnjs: "limonte-sweetalert2", max: 15, files: [s("dist/sweetalert2.all.min.js", { cdnjs: "sweetalert2.all.min.js" }), s("dist/sweetalert2.min.js", { cdnjs: "sweetalert2.min.js" }), c("dist/sweetalert2.min.css", { cdnjs: "sweetalert2.min.css" })] },
  { name: "htmx", npm: "htmx.org", cdnjs: "htmx", max: 20, files: [s("dist/htmx.min.js", { cdnjs: "htmx.min.js" })] },
  { name: "bootstrap-icons", npm: "bootstrap-icons", max: 8, files: [c("font/bootstrap-icons.min.css", { cdnjs: "font/bootstrap-icons.min.css" }), f("font/fonts/bootstrap-icons.woff2", { cdnjs: "font/fonts/bootstrap-icons.woff2" }), f("font/fonts/bootstrap-icons.woff", { cdnjs: "font/fonts/bootstrap-icons.woff" })] },

  // ── new libraries ──────────────────────────────────────────────────────────────────────────
  {
    name: "angular",
    npm: "angular",
    cdnjs: "angular.js",
    max: 40,
    files: [s("angular.min.js", { cdnjs: "angular.min.js", hosts: ["https://ajax.googleapis.com/ajax/libs/angularjs/{version}/angular.min.js"] })],
  },
  ...["route", "animate", "cookies", "resource", "sanitize", "touch", "messages", "aria", "loader"].map(angularMod),
  { name: "alpinejs", npm: "alpinejs", max: 30, files: [s("dist/cdn.min.js", { cdnjs: "cdn.min.js" })] },
  { name: "animejs", npm: "animejs", max: 8, only: /^3\./, files: [s("lib/anime.min.js", { cdnjs: "anime.min.js" })] },
  { name: "aos", npm: "aos", files: [s("dist/aos.js", { cdnjs: "aos.js" }), c("dist/aos.css", { cdnjs: "aos.css" })] },
  { name: "backbone", npm: "backbone", cdnjs: "backbone.js", files: [s("backbone-min.js", { cdnjs: "backbone-min.js" })] },
  { name: "bulma", npm: "bulma", max: 25, files: [c("css/bulma.min.css", { cdnjs: "css/bulma.min.css" })] },
  { name: "chosen", npm: "chosen-js", cdnjs: "chosen", files: [s("chosen.jquery.min.js", { cdnjs: "chosen.jquery.min.js" }), c("chosen.min.css", { cdnjs: "chosen.min.css" }), ...img("chosen-sprite.png", "chosen-sprite@2x.png")] },
  { name: "clipboard", npm: "clipboard", cdnjs: "clipboard.js", max: 15, files: [s("dist/clipboard.min.js", { cdnjs: "clipboard.min.js" })] },
  { name: "datatables", npm: "datatables.net", max: 25, files: [s("js/jquery.dataTables.min.js", { hosts: ["https://cdn.datatables.net/{version}/js/jquery.dataTables.min.js"] })] },
  { name: "datatables-dt", npm: "datatables.net-dt", max: 25, files: [c("css/jquery.dataTables.min.css", { hosts: ["https://cdn.datatables.net/{version}/css/jquery.dataTables.min.css"] }), ...img(...["asc", "asc_disabled", "both", "desc", "desc_disabled"].map((k) => `images/sort_${k}.png`))] },
  { name: "dayjs", npm: "dayjs", max: 25, files: [s("dayjs.min.js", { cdnjs: "dayjs.min.js" })] },
  { name: "fancybox", npm: "@fancyapps/fancybox", cdnjs: "fancybox", files: [s("dist/jquery.fancybox.min.js", { cdnjs: "jquery.fancybox.min.js" }), c("dist/jquery.fancybox.min.css", { cdnjs: "jquery.fancybox.min.css" })] },
  { name: "feather-icons", npm: "feather-icons", max: 12, files: [s("dist/feather.min.js", { cdnjs: "feather.min.js" })] },
  { name: "font-awesome-4", npm: "font-awesome", cdnjs: "font-awesome", files: [c("css/font-awesome.min.css", { cdnjs: "css/font-awesome.min.css", hosts: [...bootstrapcdn("font-awesome/{version}/css/font-awesome.min.css"), "https://use.fontawesome.com/releases/v{version}/css/font-awesome.min.css"] }), f("fonts/fontawesome-webfont.woff2", { cdnjs: "fonts/fontawesome-webfont.woff2" }), f("fonts/fontawesome-webfont.woff", { cdnjs: "fonts/fontawesome-webfont.woff" })] },
  { name: "gsap", npm: "gsap", max: 30, files: [s("dist/gsap.min.js", { cdnjs: "gsap.min.js" }), s("dist/ScrollTrigger.min.js", { cdnjs: "ScrollTrigger.min.js" })] },
  { name: "hammerjs", npm: "hammerjs", cdnjs: "hammer.js", files: [s("hammer.min.js", { cdnjs: "hammer.min.js" })] },
  { name: "handlebars", npm: "handlebars", cdnjs: "handlebars.js", max: 20, files: [s("dist/handlebars.min.js", { cdnjs: "handlebars.min.js" })] },
  { name: "highlightjs", npm: "@highlightjs/cdn-assets", cdnjs: "highlight.js", max: 12, files: [s("highlight.min.js", { cdnjs: "highlight.min.js" }), c("styles/default.min.css", { cdnjs: "styles/default.min.css" })] },
  { name: "hlsjs", npm: "hls.js", cdnjs: "hls.js", max: 8, files: [s("dist/hls.min.js", { cdnjs: "hls.min.js" })] },
  { name: "isotope", npm: "isotope-layout", max: 8, files: [s("dist/isotope.pkgd.min.js", { cdnjs: "isotope.pkgd.min.js" })] },
  { name: "jquery-migrate", npm: "jquery-migrate", max: 15, files: [s("dist/jquery-migrate.min.js", { cdnjs: "jquery-migrate.min.js", hosts: ["https://code.jquery.com/jquery-migrate-{version}.min.js"] })] },
  { name: "jquery-validation", npm: "jquery-validation", cdnjs: "jquery-validate", max: 15, files: [s("dist/jquery.validate.min.js", { cdnjs: "jquery.validate.min.js", hosts: ["https://ajax.aspnetcdn.com/ajax/jquery.validate/{version}/jquery.validate.min.js"] }), s("dist/additional-methods.min.js", { cdnjs: "additional-methods.min.js" })] },
  { name: "js-cookie", npm: "js-cookie", max: 12, files: [s("dist/js.cookie.min.js", { cdnjs: "js.cookie.min.js" })] },
  { name: "jszip", npm: "jszip", max: 10, files: [s("dist/jszip.min.js", { cdnjs: "jszip.min.js" })] },
  { name: "leaflet", npm: "leaflet", max: 12, files: [s("dist/leaflet.js", { cdnjs: "leaflet.js" }), c("dist/leaflet.css", { cdnjs: "leaflet.css" }), ...img("dist/images/layers.png", "dist/images/layers-2x.png", "dist/images/marker-icon.png")] },
  { name: "lightbox2", npm: "lightbox2", files: [s("dist/js/lightbox.min.js", { cdnjs: "js/lightbox.min.js" }), c("dist/css/lightbox.min.css", { cdnjs: "css/lightbox.min.css" }), ...img("dist/images/close.png", "dist/images/next.png", "dist/images/prev.png", "dist/images/loading.gif")] },
  { name: "lottie-web", npm: "lottie-web", max: 8, files: [s("build/player/lottie.min.js", { cdnjs: "lottie.min.js" })] },
  { name: "magnific-popup", npm: "magnific-popup", cdnjs: "magnific-popup.js", files: [s("dist/jquery.magnific-popup.min.js", { cdnjs: "jquery.magnific-popup.min.js" }), c("dist/magnific-popup.css", { cdnjs: "magnific-popup.min.css" })] },
  { name: "masonry", npm: "masonry-layout", max: 8, files: [s("dist/masonry.pkgd.min.js", { cdnjs: "masonry.pkgd.min.js" })] },
  { name: "materialize", npm: "materialize-css", max: 8, files: [s("dist/js/materialize.min.js", { cdnjs: "js/materialize.min.js" }), c("dist/css/materialize.min.css", { cdnjs: "css/materialize.min.css" }), f("dist/fonts/roboto/Roboto-Thin.woff2", { cdnjs: "fonts/roboto/Roboto-Thin.woff2" }), f("dist/fonts/roboto/Roboto-Light.woff2", { cdnjs: "fonts/roboto/Roboto-Light.woff2" }), f("dist/fonts/roboto/Roboto-Regular.woff2", { cdnjs: "fonts/roboto/Roboto-Regular.woff2" }), f("dist/fonts/roboto/Roboto-Medium.woff2", { cdnjs: "fonts/roboto/Roboto-Medium.woff2" }), f("dist/fonts/roboto/Roboto-Bold.woff2", { cdnjs: "fonts/roboto/Roboto-Bold.woff2" })] },
  { name: "nprogress", npm: "nprogress", files: [s("nprogress.js", { cdnjs: "nprogress.min.js" }), c("nprogress.css", { cdnjs: "nprogress.min.css" })] },
  { name: "numeral", npm: "numeral", files: [s("min/numeral.min.js", { cdnjs: "numeral.min.js" })] },
  { name: "owl-carousel", npm: "owl.carousel", cdnjs: "OwlCarousel2", files: [s("dist/owl.carousel.min.js", { cdnjs: "owl.carousel.min.js" }), c("dist/assets/owl.carousel.min.css", { cdnjs: "assets/owl.carousel.min.css" }), c("dist/assets/owl.theme.default.min.css", { cdnjs: "assets/owl.theme.default.min.css" }), ...img("dist/assets/owl.video.play.png")] },
  { name: "popperjs-v1", npm: "popper.js", cdnjs: "popper.js", max: 15, files: [s("dist/umd/popper.min.js", { cdnjs: "umd/popper.min.js" })] },
  { name: "select2", npm: "select2", max: 25, files: [s("dist/js/select2.min.js", { cdnjs: "js/select2.min.js" }), c("dist/css/select2.min.css", { cdnjs: "css/select2.min.css" })] },
  { name: "slick-carousel", npm: "slick-carousel", cdnjs: "slick-carousel", files: [s("slick/slick.min.js", { cdnjs: "slick.min.js" }), c("slick/slick.css", { cdnjs: "slick.min.css" }), c("slick/slick-theme.css", { cdnjs: "slick-theme.min.css" }), f("slick/fonts/slick.woff2", { cdnjs: "fonts/slick.woff2" }), f("slick/fonts/slick.woff", { cdnjs: "fonts/slick.woff" }), ...img("slick/ajax-loader.gif")] },
  { name: "socket-io", npm: "socket.io-client", cdnjs: "socket.io", max: 25, files: [s("dist/socket.io.min.js", { cdnjs: "socket.io.min.js" })] },
  { name: "sortablejs", npm: "sortablejs", cdnjs: "Sortable", max: 20, files: [s("Sortable.min.js", { cdnjs: "Sortable.min.js" })] },
  { name: "swiper", npm: "swiper", cdnjs: "Swiper", max: 14, since: "6.0.0", files: [s("swiper-bundle.min.js", { cdnjs: "swiper-bundle.min.js" }), c("swiper-bundle.min.css", { cdnjs: "swiper-bundle.min.css" })] },
  { name: "three", npm: "three", max: 8, since: "0.100.0", files: [s("build/three.min.js")] },
  { name: "toastr", npm: "toastr", cdnjs: "toastr.js", files: [s("build/toastr.min.js", { cdnjs: "toastr.min.js" }), c("build/toastr.min.css", { cdnjs: "toastr.min.css" })] },
  { name: "videojs", npm: "video.js", cdnjs: "video.js", max: 10, files: [s("dist/video.min.js", { cdnjs: "video.min.js", hosts: ["https://vjs.zencdn.net/{version}/video.min.js"] }), c("dist/video-js.min.css", { cdnjs: "video-js.min.css", hosts: ["https://vjs.zencdn.net/{version}/video-js.min.css"] })] },
  { name: "vue2", npm: "vue", cdnjs: "vue", only: /^2\./, max: 15, files: [s("dist/vue.min.js", { cdnjs: "vue.min.js" }), s("dist/vue.js", { cdnjs: "vue.js" })] },
  { name: "vue-router", npm: "vue-router", only: /^4\./, max: 15, files: [s("dist/vue-router.global.prod.js", { cdnjs: "vue-router.global.prod.js" })] },
  { name: "vuex", npm: "vuex", max: 12, files: [s("dist/vuex.global.prod.js", { cdnjs: "vuex.global.prod.js" }), s("dist/vuex.min.js", { cdnjs: "vuex.min.js" })] },
  { name: "waypoints", npm: "waypoints", files: [s("lib/jquery.waypoints.min.js", { cdnjs: "jquery.waypoints.min.js" })] },
  { name: "webfontloader", npm: "webfontloader", cdnjs: "webfont", files: [s("webfontloader.js", { cdnjs: "webfontloader.js", hosts: ["https://ajax.googleapis.com/ajax/libs/webfont/{version}/webfontloader.js"] })] },
  { name: "wow", npm: "wow.js", cdnjs: "wow", files: [s("dist/wow.min.js", { cdnjs: "wow.min.js" })] },
  { name: "lazysizes", npm: "lazysizes", max: 12, files: [s("lazysizes.min.js", { cdnjs: "lazysizes.min.js" })] },
  { name: "tether", npm: "tether", max: 8, files: [s("dist/js/tether.min.js", { cdnjs: "js/tether.min.js" })] },
  { name: "bootstrap-datepicker", npm: "bootstrap-datepicker", max: 10, files: [s("dist/js/bootstrap-datepicker.min.js", { cdnjs: "js/bootstrap-datepicker.min.js" }), c("dist/css/bootstrap-datepicker.min.css", { cdnjs: "css/bootstrap-datepicker.min.css" })] },
  { name: "foundation", npm: "foundation-sites", cdnjs: "foundation", max: 12, files: [s("dist/js/foundation.min.js", { cdnjs: "js/foundation.min.js" }), c("dist/css/foundation.min.css", { cdnjs: "css/foundation.min.css" })] },
  { name: "semantic-ui", npm: "semantic-ui", max: 4, files: [s("dist/semantic.min.js", { cdnjs: "semantic.min.js" }), c("dist/semantic.min.css", { cdnjs: "semantic.min.css" }), f("dist/themes/default/assets/fonts/icons.woff2", { cdnjs: "themes/default/assets/fonts/icons.woff2" }), f("dist/themes/default/assets/fonts/outline-icons.woff2", { cdnjs: "themes/default/assets/fonts/outline-icons.woff2" }), f("dist/themes/default/assets/fonts/brand-icons.woff2", { cdnjs: "themes/default/assets/fonts/brand-icons.woff2" }), ...img("dist/themes/default/assets/images/flags.png")] },
];
