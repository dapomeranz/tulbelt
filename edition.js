// Which build of Tulbelt this is. The free build ships this file as-is; the
// paid Tulbelt Plus build replaces it wholesale with its own copy. Keep this the
// only file the Plus build overwrites, so pulling free changes into Plus never
// conflicts — new free behavior goes elsewhere, and only reads from here.

export const EDITION = {
  id: "free",
  name: "Tulbelt",
};

// Appended after the free FEATURES, so free rule IDs (index-based) stay stable.
export const EXTRA_FEATURES = [];
