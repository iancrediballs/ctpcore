// Batch_Layers_To_PNG.jsx
// For each top-level layer/group on the active document: scale it to FIT the
// canvas (contain, centred, with margin), put a white background behind it,
// and export a canvas-sized PNG named after the layer.
// Run:  File ▸ Scripts ▸ Browse…  (or drop into Presets/Scripts and restart PS)
#target photoshop

(function () {
  if (!app.documents.length) { alert("Open your PSD first."); return; }
  var src = app.activeDocument;

  // ---------- SETTINGS ----------
  var MARGIN   = 0.08;   // padding around the part (8% of canvas)
  var WHITE_BG = true;   // false = keep transparent background
  // ------------------------------

  var outDir = Folder.selectDialog("Choose an output folder for the PNGs");
  if (!outDir) return;

  var oldUnits = app.preferences.rulerUnits;
  app.preferences.rulerUnits = Units.PIXELS;

  var W = src.width.as("px");
  var H = src.height.as("px");

  // snapshot the top-level layer names (so duplicating doesn't disturb the loop)
  var names = [];
  for (var i = 0; i < src.layers.length; i++) names.push(src.layers[i].name);

  var count = 0;
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var dup = src.duplicate(name + "_tmp", false);
    try {
      // show ONLY the matching layer
      var target = null;
      for (var j = 0; j < dup.layers.length; j++) {
        var match = (dup.layers[j].name === name);
        dup.layers[j].visible = match;
        if (match) target = dup.layers[j];
      }
      if (target === null) { dup.close(SaveOptions.DONOTSAVECHANGES); continue; }
      dup.activeLayer = target;

      // scale to fit (contain) + centre
      var b = target.bounds;
      var lw = b[2].as("px") - b[0].as("px");
      var lh = b[3].as("px") - b[1].as("px");
      if (lw > 0 && lh > 0) {
        var scale = Math.min(W * (1 - MARGIN * 2) / lw, H * (1 - MARGIN * 2) / lh) * 100;
        target.resize(scale, scale, AnchorPosition.MIDDLECENTER);
        b = target.bounds;
        var cx = (b[0].as("px") + b[2].as("px")) / 2;
        var cy = (b[1].as("px") + b[3].as("px")) / 2;
        target.translate(W / 2 - cx, H / 2 - cy);
      }

      // white background behind it
      if (WHITE_BG) {
        var bg = dup.artLayers.add();
        bg.move(dup, ElementPlacement.PLACEATEND);
        dup.activeLayer = bg;
        dup.selection.selectAll();
        var white = new SolidColor();
        white.rgb.red = 255; white.rgb.green = 255; white.rgb.blue = 255;
        dup.selection.fill(white);
        dup.selection.deselect();
      }

      // export canvas-sized PNG
      var safe = name.replace(/[\\\/:*?"<>|]/g, "_");
      var f = new File(outDir.fsName + "/" + safe + ".png");
      dup.saveAs(f, new PNGSaveOptions(), true, Extension.LOWERCASE);
      count++;
    } catch (e) { /* skip problem layer, keep going */ }
    dup.close(SaveOptions.DONOTSAVECHANGES);
  }

  app.preferences.rulerUnits = oldUnits;
  alert("Exported " + count + " PNG(s) to:\n" + outDir.fsName);
})();
