# Office asset provenance

These WebP images are local crops of the user's supplied, approved “A · Office + Inspector” design reference (`ChatGPT Image Oct 12, 2026, 07_06_46 PM.png`, supplied October 12, 2026). The full reference and its device frames are not distributed. Example task/status labels were removed from the office crop; the app overlays actual agent state. The four portraits are illustrative role crops of that same artwork.

The old `office.webp` is retained for historical compatibility but is no longer loaded by the 3D renderer. Only the illustrative inspector portraits are used from the reference. Those earlier assets were prepared locally. On October 12 the user subsequently authorized one 12UI reference conversion and fixture-preview upload, capped at $0.15; its ledger reports sponsored funding and $0 charged. Echo's coordinator tile retains the application's existing humanoid.

`humans/` contains original MakeHuman data assets, not MakeHuman application code. The base OBJ, skeleton and skin weights were downloaded from https://github.com/makehumancommunity/makehuman/tree/master/makehuman/data. Clothing, hair, eyes and skin textures were downloaded from the official `makehuman_system_assets_cc0.zip` pack using HTTP range requests. These assets are explicitly CC0: https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html. The full asset license is `humans/LICENSE.ASSETS.md`; clothing/fitting files retain their original creator and license headers. The local parser and animation implementation are authored for Echo.

`props/` contains Poly Haven's CC0 `potted_plant_02`, `wood_table_001` and `wood_planks_grey` 1K assets, downloaded using their public asset API. License: https://polyhaven.com/license. These local files do not require a runtime external API or network connection to the asset provider. Their meshes/textures are unmodified originals. No Poly Haven website preview images are redistributed.

The local prototype is skeletal 3D, but not yet photorealistic. Screens project reported task/activity state; they are not live screenshots of agent computers. Publication remains pending user review.

The cyberpunk exterior (`cyberpunk-city-v1.png`) was newly generated with the built-in image tool, without uploading reference images or screenshots. Its full prompt and mode are recorded in `cyberpunk-city-v1.prompt.md`. `echo-panel-wall.jpg` is an unchanged copy of the existing Mac `renderer/background.jpg`, explicitly requested for the office wall treatment. Both assets are local in both applications; runtime does not contact an image service. Wall artwork and facade art are decorative, not live system-status readouts.

CC0 `shoes01.obj` and its original fitting file were added from the same official MakeHuman system pack. Their mesh follows the foot bones rather than floating independently. Room window reveals/sills, wall backing, ceiling-fixture supports and monitor stands remain real scene geometry.
## Reference-alignment UI icons

`ui/document.svg`, `ui/search.svg` and `ui/list.svg` were extracted by 12UI from the user's approved A: Office + Inspector reference on October 12. They describe only reported activity in the inspector; no sample task progress or reference photograph is shipped as a working agent. The conversion/permission/spend and adaptation record is in `docs/office-review/12UI-ALIGNMENT.md` on Mac and `docs/office-12ui-alignment.md` on Phone. Existing character, room and exterior asset provenance above is unchanged.
