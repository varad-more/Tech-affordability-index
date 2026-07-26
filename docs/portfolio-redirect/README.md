# Redirect stub for the old URL

This site used to be served from `varadmore.me/Tech-affordability-index/`, as a
GitHub Pages *project* page under the portfolio's apex domain. It now has its own
subdomain, and a project page can only be served from one place — so that path
went dead the moment the custom domain took effect.

`index.html` in this folder fills the hole. It belongs in the **portfolio** repo
(`varad-more.github.io`), not this one:

```
varad-more.github.io/
└── Tech-affordability-index/
    └── index.html        ← copy it here
```

That covers the URL that was actually linked. To also carry over the sub-pages,
drop the *same file* into each of these — it reads the path it was served from
and rewrites the prefix, so one file handles every case:

```
Tech-affordability-index/states/index.html
Tech-affordability-index/timing/index.html
Tech-affordability-index/method/index.html
Tech-affordability-index/timing.html      ← only if the old .html URLs matter
Tech-affordability-index/method.html
```

The last two are the addresses the site used before it moved to clean URLs. The
stub maps them onto `/timing/` and `/method/` rather than forwarding them
verbatim, because the destination serves nothing from a `.html` address.

The `<link rel="canonical">` is the part that matters for search: it tells
crawlers the old address and the new one are the same page, so ranking follows
the move instead of restarting from zero.
