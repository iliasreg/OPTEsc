"""Independent IFC check with IfcOpenShell: schema + EXPRESS rules, and builds every element's geometry.
Usage: python3 ifc_check.py file.ifc [...]   Prints one JSON line per file."""

import json
import sys

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.validate

for path in sys.argv[1:]:
    f = ifcopenshell.open(path)
    log = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(f, log, express_rules=True)
    settings = ifcopenshell.geom.settings()
    ok, failed = 0, []
    for el in f.by_type("IfcProduct"):
        if not el.Representation:
            continue
        try:
            ifcopenshell.geom.create_shape(settings, el)
            ok += 1
        except Exception as e:  # noqa: BLE001
            failed.append(f"{el.is_a()} {el.Name}: {e}")
    print(
        json.dumps(
            {
                "file": path,
                "schema": f.schema,
                "counts": {
                    t: len(f.by_type(t))
                    for t in ("IfcWall", "IfcDoor", "IfcWindow", "IfcSpace")
                },
                "validation_issues": [
                    str(s.get("message", s))[:200] for s in log.statements
                ],
                "geometry_ok": ok,
                "geometry_failed": failed,
            }
        )
    )
