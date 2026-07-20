import { describe, expect, it } from 'vitest'

import { createRandom } from '../random'
import { createShadingMask, createToneField } from '../shadingFields'
import { chooseScribbleGrowthStep } from '../scribbleStrategy/growth'
import { scribbleStrategy } from '../scribbleStrategy/index'
import { createScribbleModel } from '../scribbleStrategy/model'
import type { Point } from '../types'

const FRAME = { width: 24, height: 16 }
const SOURCE = {
  toneField: createToneField(([x, y]) => 0.25 + 0.6 * (x / 24) * (y / 16)),
  shadingMask: createShadingMask(([x, y]) =>
    Math.hypot(x - 12, y - 8) <= 9 ? 1 : 0,
  ),
}
const CONTROLS = {
  pathDensity: 0.5,
  scribbleScale: 2,
  momentum: 0.65,
  chaos: 0.35,
  toneFidelity: 0.4,
  stopPoint: 1,
}

describe('baseline Scribble output golden', () => {
  it('preserves representative production geometry byte for byte', () => {
    const result = scribbleStrategy({
      source: SOURCE,
      frame: FRAME,
      controls: CONTROLS,
      seed: 'scale-field-production-golden',
    })

    expect(JSON.stringify(result)).toMatchInlineSnapshot(`"{"polylines":[[[9.333333333333334,12.533333333333333],[9.305890209759438,12.522803614984397],[9.251003962611648,12.501744178286527],[9.168674591889962,12.47015502323972],[9.05890209759438,12.42803614984398],[8.9643043250888,12.423158159460455],[8.884881274373225,12.455521052089146],[8.820632945447649,12.525124827730057],[8.771559338312075,12.631969486383186],[8.710121722774366,12.728141819745854],[8.63632009883452,12.81364182781806],[8.550154466492538,12.888469510599808],[8.451624825748421,12.9526248680911],[8.381797897996167,13.029852082440827],[8.340673683235778,13.120151153648996],[8.328252181467253,13.223522081715604],[8.344533392690591,13.339964866640651],[8.370542094585321,13.453251162992538],[8.406278287151444,13.563380970771263],[8.451741970388957,13.670354289976828],[8.506933144297863,13.77417112060923],[8.527110848470592,13.87237815512271],[8.512275082907145,13.96497539351727],[8.462425847607523,14.051962835792903],[8.377563142571725,14.133340481949617],[8.322920831381976,14.2223543359523],[8.298498914038273,14.319004397800956],[8.304297390540619,14.423290667495582],[8.340316260889011,14.535213145036181],[8.371299950296619,14.648279610979777],[8.39724845876344,14.762490065326379],[8.418161786289478,14.877844508075977],[8.434039932874725,14.99434293922858],[8.460865765297457,15.107044148430678],[8.49863928355767,15.215948135682268],[8.547360487655364,15.32105490098336],[8.607029377590536,15.422364444333944],[8.681074891605267,15.500769524363776],[8.769497029699558,15.556270141072854],[8.872295791873402,15.588866294461177],[8.989471178126806,15.598557984528748],[9.106646680232458,15.608248273500626],[9.223822298190363,15.617937161376814],[9.340998032000519,15.62762464815731],[9.458173881662923,15.637310733842115],[9.575346764901672,15.647032441528443],[9.692516681716766,15.656789771216292],[9.809683632108204,15.666582722905664],[9.926847616075987,15.676411296596557],[10.043273046801671,15.690765420687073],[10.15895992428526,15.709645095177216],[10.273908248526748,15.73305032006698],[10.388118019526141,15.760981095356367],[10.473775347775685,15.781929176823407],[10.530880233275381,15.795894564468103],[10.55943267602523,15.802877258290449]]],"termination":"stopped-early","residualError":0.24500694893390038}"`)
  })

  it('preserves direct growth and shared RNG routing', () => {
    const model = createScribbleModel(SOURCE, FRAME, CONTROLS)
    const rng = createRandom('scale-field-growth-golden')
    let current: Point = [12, 8]
    let heading: number | undefined
    const steps = []

    for (let index = 0; index < 3; index++) {
      const step = chooseScribbleGrowthStep({ model, rng, current, heading })
      steps.push(step)
      if (step.kind === 'stagnated') break
      model.depositSegment(current, step.point)
      current = step.point
      heading = step.heading
    }

    expect({ steps, nextRandomValue: rng.value() }).toMatchInlineSnapshot(`
      {
        "nextRandomValue": 0.1840914092026651,
        "steps": [
          {
            "heading": 2.0076820445762067,
            "kind": "advanced",
            "point": [
              11.801005921411157,
              8.426128333588109,
            ],
          },
          {
            "heading": 3.132259585117975,
            "kind": "advanced",
            "point": [
              11.330724373751737,
              8.430517630919143,
            ],
          },
          {
            "heading": 1.8321896332840417,
            "kind": "advanced",
            "point": [
              11.209185734659005,
              8.88484390047384,
            ],
          },
        ],
      }
    `)
  })
})
