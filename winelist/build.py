"""Build the wine list PDF.  Usage: python3 build.py   (pip install typst)"""
import typst, pathlib
here = pathlib.Path(__file__).parent
fonts = [str(here / "fonts")] if (here / "fonts").is_dir() else []
typst.compile(str(here / "main.typ"), output=str(here / "wine-list.pdf"), font_paths=fonts)
print("wrote", here / "wine-list.pdf")
