
import {fork} from "child_process";

const pro = fork('./sh.js')

pro.send('hi')