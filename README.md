# Guide Builder

A browser app for making step-by-step assembly guides from STL files. It runs offline; all libraries are in `vendor/`. Free and open source under the MIT License.

Guides can be exported as PDF, Markdown, or an interactive 3D web page. The web page uses the companion project [Guide Viewer](../_guide_viewer/), a single read-only HTML file that you can embed anywhere.

## Start

Double-click **`Start Guide Builder.bat`**, or run `python serve.py`. The app opens at http://127.0.0.1:8765/.
It needs a local server because browsers block JavaScript modules loaded from `file://`.

Your work is autosaved in the browser. Use **Save** to write a `.guide` project file (a zip holding the project, the meshes and the photos) that you can keep, back up or move to another computer.

## Workflow

1. **Import STL / 3MF** (button or drag and drop). You can import several files at once.
   - 3MF files from Bambu Studio, Orca, PrusaSlicer, Fusion and others come in with their object and part names and their positions. Modifier, negative and support volumes are skipped. Filament colours are used when the parts have different ones.

   Options:
   - split disconnected bodies into separate parts (hollow inner shells stay with their part)
   - detect screw and insert holes
   - keep the positions from the file (good for assemblies exported from CAD) or arrange the parts side by side
2. **Build steps.** Each step stores which parts are visible, where they are, how they look (auto, normal, highlight or ghost), the camera, the explode amount, callouts and arrows.
   - **＋ New step** continues from the current step.
   - With **Carry fwd** on, a change also applies to later steps, up to the first step where you set that part differently.
   - Parts that first appear in a step are highlighted automatically and listed under "Parts" for that step.
3. **Position parts**
   - Click a part to select it, and shift-click to add more. **W** moves and **E** rotates, with snapping set in the toolbar.
   - In the Selection tab you can type a position or rotation, rotate by ±90°, drop the part to the bed, centre it, or reset it to its file position.
   - **Mate**: click a hole or face on the part you want to move, then the matching hole or face on the target part. The first part is turned and moved so the two meet.
   - **Lay flat**: click a face to put it on the bed.
   - **Align**: with 2 or more parts selected, line up their min, centre or max on X, Y or Z with the first part you selected. You can also stack them on it.
4. **Holes**
   - Detected holes are shown as coloured rings and tubes. Detection finds round holes and hex nut traps, through or blind, with counterbores and countersinks.
   - Click a ring to change its type, size or depth, flip its axis, hide it or delete it. **◎ Hole** adds a hole by hand.
   - The **Hole types** tab holds the rules that turn a diameter into a type (for example 3.8–4.8 mm blind = M3 heat-set insert), the marker colours and the hardware names. Edit them to match your printer tolerances, then click *Re-classify*.
   - **Suggest from holes** in the Step tab counts the hardware needed by the parts that are new in that step.
5. **Write**
   - Each step has a title, instructions in Markdown, tip/warning/note boxes, a hardware list, photos (drop images on the viewport) and callout labels you can drag around.
   - Sections group steps. Drag steps in the outline to reorder them.
   - The Guide tab holds the title, author, introduction, requirements and the cover picture.
6. **Export**
   - **PDF** contains a cover, table of contents, hole legend, parts list with thumbnails, section pages, and steps at 1 or 2 per page.
   - **Markdown** is either a zip with the `.md` file plus `images/` and `parts/` folders, or a single `.md` with the images embedded.
   - **HTML** is one page with the interactive 3D guide: readers step through it, turn the model, and see the text, notes, hardware and photos for each step. Nothing can be edited. You can open it directly, host it, or embed it on any website with an `<iframe>`. It uses [Guide Viewer](../_guide_viewer/) (a copy is in `vendor/guide-viewer.html`) and loads three.js from a CDN, so readers need an internet connection.
   - **Preview** shows the guide before you export it.
   - The dashed frame in the viewport is exactly what the step picture will show. Its aspect comes from the picture size in the Export tab.

You can also **Import MD** to bring in an existing Markdown guide: `#` becomes the title, `##` sections and `###` steps. Select the images together with the `.md` file so they are attached.

## Keys

| Key | Action |
|---|---|
| W / E | Move / rotate gizmo |
| F | Fit the view (to the selection if there is one) |
| H or Del | Hide the selected parts in this step |
| PgUp / PgDn | Previous / next step |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+S / Ctrl+Shift+S | Save / save as |
| Ctrl+D | Duplicate the step |
| Esc | Cancel the tool and clear the selection |

## Files

- `js/stl.js`: STL reading and writing, vertex welding, splitting into bodies
- `js/threemf.js`: 3MF reading (core spec, Bambu/Orca production files, PrusaSlicer volumes)
- `js/holes.js`: hole detection and the default hole types
- `js/viewer.js`: three.js viewport, gizmo, markers, callouts, picture rendering
- `js/model.js`: project data, undo, autosave, `.guide` files, Markdown import
- `js/export.js`: PDF (jsPDF) and Markdown export
- `js/main.js`: user interface

You can test hole detection without a browser: `node -e "import('./js/holes.js')"` (it has no three.js dependency).

When you change Guide Viewer, copy `guide-viewer.html` into `vendor/` so **Export HTML** uses the new version.

## License

Guide Builder is open source under the [MIT License](LICENSE). The bundled libraries keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Contributions are welcome. Keep the app dependency-free at run time: no build step, and every library goes in `vendor/` so it works offline.
