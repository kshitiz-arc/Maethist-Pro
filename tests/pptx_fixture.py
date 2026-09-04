"""Builds a small but representative .pptx for import tests.

Covers the element kinds a real deck leans on: a title and body text
box, an autoshape with text, an ellipse, an embedded picture, a
connector, a positioned table, a group, and a star preset -- on a 4:3
deck so non-16:9 sizing is exercised too.
"""
import zipfile, pathlib, io
from PIL import Image, ImageDraw

EMU_IN = 914400
# 4:3 deck (10in x 7.5in) so we can check non-16:9 sizing survives import.
CX, CY = 10 * EMU_IN, int(7.5 * EMU_IN)

img = Image.new("RGB", (400, 300), "#1d4ed8")
d = ImageDraw.Draw(img)
d.ellipse((60, 40, 340, 260), fill="#f59e0b")
d.rectangle((20, 20, 380, 280), outline="#ffffff", width=6)
buf = io.BytesIO(); img.save(buf, "PNG")
IMAGE = buf.getvalue()

A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'


def xfrm(x, y, cx, cy):
    return '<a:xfrm><a:off x="%d" y="%d"/><a:ext cx="%d" cy="%d"/></a:xfrm>' % (x, y, cx, cy)


def textbox(idn, name, x, y, cx, cy, runs, anchor="t"):
    paras = ""
    for text, size, bold, color, align in runs:
        paras += (
            '<a:p><a:pPr algn="%s"/>'
            '<a:r><a:rPr lang="en-US" sz="%d" b="%d" dirty="0">'
            '<a:solidFill><a:srgbClr val="%s"/></a:solidFill></a:rPr>'
            '<a:t>%s</a:t></a:r></a:p>' % (align, size, 1 if bold else 0, color, text)
        )
    return (
        '<p:sp><p:nvSpPr><p:cNvPr id="%d" name="%s"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        '<p:spPr>%s<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
        '<p:txBody><a:bodyPr wrap="square" anchor="%s"><a:normAutofit/></a:bodyPr>'
        '<a:lstStyle/>%s</p:txBody></p:sp>' % (idn, name, xfrm(x, y, cx, cy), anchor, paras)
    )


def shape(idn, name, prst, x, y, cx, cy, fill, text=None):
    if text:
        body = ('<p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/>'
                '<a:r><a:rPr lang="en-US" sz="1400" b="1">'
                '<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr>'
                '<a:t>%s</a:t></a:r></a:p></p:txBody>' % text)
    else:
        body = '<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>'
    return (
        '<p:sp><p:nvSpPr><p:cNvPr id="%d" name="%s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
        '<p:spPr>%s<a:prstGeom prst="%s"><a:avLst/></a:prstGeom>'
        '<a:solidFill><a:srgbClr val="%s"/></a:solidFill>'
        '<a:ln w="19050"><a:solidFill><a:srgbClr val="0F172A"/></a:solidFill></a:ln>'
        '</p:spPr>%s</p:sp>' % (idn, name, xfrm(x, y, cx, cy), prst, fill, body)
    )


def picture(idn, x, y, cx, cy):
    return (
        '<p:pic><p:nvPicPr><p:cNvPr id="%d" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>'
        '<p:blipFill><a:blip r:embed="rId9"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
        '<p:spPr>%s<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
        % (idn, xfrm(x, y, cx, cy))
    )


def connector(idn, x, y, cx, cy):
    return (
        '<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="%d" name="Line"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>'
        '<p:spPr>%s<a:prstGeom prst="line"><a:avLst/></a:prstGeom>'
        '<a:ln w="28575"><a:solidFill><a:srgbClr val="DC2626"/></a:solidFill></a:ln>'
        '</p:spPr></p:cxnSp>' % (idn, xfrm(x, y, cx, cy))
    )


def table(idn, x, y, cx, cy):
    def cell(t):
        return ('<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r>'
                '<a:rPr lang="en-US" sz="1200"/><a:t>%s</a:t></a:r></a:p></a:txBody>'
                '<a:tcPr/></a:tc>' % t)
    rows = ""
    for a, b in [("Class", "Topic"), ("9", "Constructions"), ("10", "Circles")]:
        rows += '<a:tr h="370840">%s%s</a:tr>' % (cell(a), cell(b))
    return (
        '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="%d" name="Table"/>'
        '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
        '<p:xfrm><a:off x="%d" y="%d"/><a:ext cx="%d" cy="%d"/></p:xfrm>'
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">'
        '<a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>'
        '<a:gridCol w="%d"/><a:gridCol w="%d"/></a:tblGrid>%s</a:tbl>'
        '</a:graphicData></a:graphic></p:graphicFrame>'
        % (idn, x, y, cx, cy, cx // 2, cx // 2, rows)
    )


def group(idn, x, y, cx, cy):
    return (
        '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="%d" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        '<p:grpSpPr><a:xfrm><a:off x="%d" y="%d"/><a:ext cx="%d" cy="%d"/>'
        '<a:chOff x="0" y="0"/><a:chExt cx="%d" cy="%d"/></a:xfrm></p:grpSpPr>'
        % (idn, x, y, cx, cy, cx, cy)
        + shape(idn + 1, "GroupRect", "roundRect", 0, 0, cx // 2, cy, "10B981", "In group")
        + shape(idn + 2, "GroupTri", "triangle", cx // 2, 0, cx // 2, cy, "8B5CF6")
        + '</p:grpSp>'
    )


def slide(shapes):
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<p:sld %s %s %s><p:cSld><p:spTree>'
            '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
            '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
            '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
            '%s</p:spTree></p:cSld></p:sld>' % (A, P, R, shapes))


S = EMU_IN // 96  # emu per css px at 96dpi

slide1 = slide(
    textbox(2, "Title", 60 * S, 40 * S, 840 * S, 70 * S,
            [("Chapter 11 - Constructions", 3200, True, "0F172A", "l")])
    + textbox(3, "Body", 60 * S, 130 * S, 460 * S, 260 * S,
              [("Divide a segment in a ratio", 1800, False, "334155", "l"),
               ("Tangents from an external point", 1800, False, "334155", "l"),
               ("Similar triangles by scale factor", 1800, False, "334155", "l")])
    + shape(4, "Rect", "rect", 560 * S, 130 * S, 160 * S, 90 * S, "2563EB", "Rect")
    + shape(5, "Ellipse", "ellipse", 740 * S, 130 * S, 160 * S, 90 * S, "DB2777", "Ellipse")
    + picture(6, 560 * S, 250 * S, 200 * S, 150 * S)
    + connector(7, 60 * S, 420 * S, 400 * S, 0)
    + table(8, 60 * S, 450 * S, 380 * S, 110 * S)
    + group(20, 560 * S, 430 * S, 340 * S, 110 * S)
)
slide2 = slide(
    textbox(2, "Title2", 60 * S, 250 * S, 840 * S, 100 * S,
            [("Second slide - centred", 4000, True, "B91C1C", "ctr")])
    + shape(3, "Star", "star5", 380 * S, 60 * S, 180 * S, 160 * S, "F59E0B")
)

pres = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:presentation %s %s %s><p:sldIdLst>'
        '<p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>'
        '<p:sldSz cx="%d" cy="%d"/><p:notesSz cx="%d" cy="%d"/></p:presentation>'
        % (A, P, R, CX, CY, CY, CX))

theme = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
         '<a:theme %s name="T"><a:themeElements><a:clrScheme name="C">'
         '<a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>'
         '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>'
         '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>'
         '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>'
         '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>'
         '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>'
         '</a:clrScheme><a:fontScheme name="F"><a:majorFont><a:latin typeface="Calibri Light"/>'
         '<a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/>'
         '<a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
         '<a:fmtScheme name="S"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
         '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
         '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>'
         '<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
         '<a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
         '<a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
         '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>'
         '<a:effectStyle><a:effectLst/></a:effectStyle>'
         '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
         '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
         '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
         '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>'
         '</a:fmtScheme></a:themeElements></a:theme>' % A)

master = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<p:sldMaster %s %s %s><p:cSld><p:spTree>'
          '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
          '<p:grpSpPr/></p:spTree></p:cSld>'
          '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" '
          'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" '
          'hlink="hlink" folHlink="folHlink"/>'
          '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
          '</p:sldMaster>' % (A, P, R))

layout = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<p:sldLayout %s %s %s type="blank"><p:cSld><p:spTree>'
          '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
          '<p:grpSpPr/></p:spTree></p:cSld>'
          '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>' % (A, P, R))


def rels(items):
    body = "".join(
        '<Relationship Id="%s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/%s" Target="%s"/>' % it
        for it in items)
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + body + '</Relationships>')


ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      '<Default Extension="xml" ContentType="application/xml"/>'
      '<Default Extension="png" ContentType="image/png"/>'
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
      '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
      '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
      '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
      '</Types>')

def build_sample_pptx(directory):
    path = pathlib.Path(directory) / "sample.pptx"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr("_rels/.rels", rels([("rId1", "officeDocument", "ppt/presentation.xml")]))
        z.writestr("ppt/presentation.xml", pres)
        z.writestr("ppt/_rels/presentation.xml.rels", rels([
            ("rId1", "slide", "slides/slide1.xml"),
            ("rId2", "slide", "slides/slide2.xml"),
            ("rId3", "slideMaster", "slideMasters/slideMaster1.xml"),
            ("rId4", "theme", "theme/theme1.xml")]))
        z.writestr("ppt/slides/slide1.xml", slide1)
        z.writestr("ppt/slides/slide2.xml", slide2)
        z.writestr("ppt/slides/_rels/slide1.xml.rels", rels([
            ("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"),
            ("rId9", "image", "../media/image1.png")]))
        z.writestr("ppt/slides/_rels/slide2.xml.rels", rels([
            ("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml")]))
        z.writestr("ppt/slideLayouts/slideLayout1.xml", layout)
        z.writestr("ppt/slideLayouts/_rels/slideLayout1.xml.rels", rels([
            ("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")]))
        z.writestr("ppt/slideMasters/slideMaster1.xml", master)
        z.writestr("ppt/slideMasters/_rels/slideMaster1.xml.rels", rels([
            ("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"),
            ("rId2", "theme", "../theme/theme1.xml")]))
        z.writestr("ppt/theme/theme1.xml", theme)
        z.writestr("ppt/media/image1.png", IMAGE)
    return path
