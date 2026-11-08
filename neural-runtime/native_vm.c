/* Native encrypted stack VM. No decoded code survives an activation. */
#define PY_SSIZE_T_CLEAN
#include <Python.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#ifdef __APPLE__
#include <Accelerate/Accelerate.h>
#include <CommonCrypto/CommonDigest.h>
#include <CommonCrypto/CommonHMAC.h>
static void sha(const void *p, size_t n, uint8_t *out) { CC_SHA256(p, (CC_LONG)n, out); }
static void mac(const void *key, const void *p, size_t n, uint8_t *out) { CCHmac(kCCHmacAlgSHA256, key, 32, p, n, out); }
#else
#include <cblas.h>
#include <openssl/sha.h>
#include <openssl/hmac.h>
static void sha(const void *p, size_t n, uint8_t *out) { SHA256(p, n, out); }
static void mac(const void *key, const void *p, size_t n, uint8_t *out) { unsigned size=32; HMAC(EVP_sha256(), key, 32, p, n, out, &size); }
#endif

enum { MAX_REGIONS=4, MAX_CODE=648, MAX_WORDS=128, MAX_STACK=32, MAX_REGISTERS=32 };
typedef struct { size_t length; uint8_t cipher[MAX_CODE], tag[32]; } Region;
typedef struct { Region regions[MAX_REGIONS]; } Image;
typedef struct { const Image *image; const uint8_t *keys[MAX_REGIONS]; unsigned active, depth, maximum, budget; const char *error; } Execution;

static void wipe(void *ptr, size_t n) { volatile uint8_t *p=ptr; while(n--) *p++=0; }
static uint32_t little32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1]<<8 | (uint32_t)p[2]<<16 | (uint32_t)p[3]<<24; }
static void image_free(PyObject *capsule) { Image *p=PyCapsule_GetPointer(capsule,"mirage.vm.v2"); if(p) {wipe(p,sizeof(*p));PyMem_Free(p);} }

static PyObject *prepare(PyObject *self, PyObject *arg) {
    (void)self;
    if(!PyTuple_Check(arg) || PyTuple_GET_SIZE(arg)!=MAX_REGIONS) {PyErr_SetString(PyExc_ValueError,"The native VM requires four regions.");return NULL;}
    Image *image=PyMem_Calloc(1,sizeof(*image));
    if(!image) return PyErr_NoMemory();
    for(int i=0;i<MAX_REGIONS;i++) {
        PyObject *row=PyTuple_GET_ITEM(arg,i);
        if(!PyTuple_Check(row)||PyTuple_GET_SIZE(row)!=2) goto invalid;
        PyObject *cipher=PyTuple_GET_ITEM(row,0), *tag=PyTuple_GET_ITEM(row,1);
        if(!PyBytes_Check(cipher)||!PyBytes_Check(tag)||PyBytes_GET_SIZE(tag)!=32||PyBytes_GET_SIZE(cipher)<8||PyBytes_GET_SIZE(cipher)>MAX_CODE) goto invalid;
        Region *r=&image->regions[i];r->length=(size_t)PyBytes_GET_SIZE(cipher);
        memcpy(r->cipher,PyBytes_AS_STRING(cipher),r->length);memcpy(r->tag,PyBytes_AS_STRING(tag),32);
    }
    return PyCapsule_New(image,"mirage.vm.v2",image_free);
invalid:
    wipe(image,sizeof(*image));PyMem_Free(image);PyErr_SetString(PyExc_ValueError,"Invalid native region capsule.");return NULL;
}

static int interpret(Execution *e, unsigned id, uint32_t x, uint32_t y, uint32_t z, unsigned argc, uint32_t *result) {
    uint8_t plain[MAX_CODE]={0}, digest[32]={0}, seed[36]={0};
    uint32_t regs[MAX_REGISTERS]={x,y,z}, stack[MAX_STACK]={0};
    int success=0, entered=0; unsigned top=0;
    if(id>=MAX_REGIONS || (e->active & (1u<<id)) || e->depth>=MAX_REGIONS) {e->error="Concurrent or recursive entry is not supported.";goto cleanup;}
    const Region *r=&e->image->regions[id];
    e->active|=1u<<id;e->depth++;entered=1;if(e->depth>e->maximum)e->maximum=e->depth;
    mac(e->keys[id],r->cipher,r->length,digest);
    unsigned mismatch=0;for(unsigned i=0;i<32;i++) mismatch|=digest[i]^r->tag[i];
    if(mismatch) {e->error="Model output cannot decode this bytecode generation.";goto cleanup;}
    memcpy(seed,e->keys[id],32);
    for(size_t start=0;start<r->length;start+=32) {
        uint32_t counter=(uint32_t)(start/32);
        for(unsigned j=0;j<4;j++)seed[32+j]=(uint8_t)(counter>>(j*8));
        sha(seed,36,digest);
        for(unsigned j=0;j<32&&start+j<r->length;j++)plain[start+j]=r->cipher[start+j]^digest[j];
    }
    unsigned count=plain[6]|(unsigned)plain[7]<<8, nregs=plain[4], nargs=plain[5];
    if(memcmp(plain,"MVM2",4)||nregs<2||nregs>MAX_REGISTERS||nargs!=argc||nargs>nregs||count<1||count>MAX_WORDS||r->length!=8+5*count) {e->error="Invalid native bytecode header.";goto cleanup;}
    uint32_t initialized=(1u<<nargs)-1u;
    for(unsigned pc=0;pc<count;pc++) {
        if(e->budget--==0) {e->error="Instruction budget exceeded.";goto cleanup;}
        unsigned op=plain[8+5*pc];uint32_t arg=little32(plain+9+5*pc),a,b,value;
        if(op==1) {
            if(arg>=nregs||!(initialized&(1u<<arg))||top>=MAX_STACK)goto invalid;
            stack[top++]=regs[arg];
        } else if(op==2) {
            if(top>=MAX_STACK)goto invalid;
            stack[top++]=arg;
        } else if(op==3) {
            if(top<1||arg<2||arg>=nregs)goto invalid;
            regs[arg]=stack[--top];initialized|=1u<<arg;
        } else if(op==4) {
            if(top!=1||arg||pc+1!=count)goto invalid;
            *result=stack[0];success=1;goto cleanup;
        } else if(op==14) {
            if(top<1||arg>INT32_MAX)goto invalid;
            a=stack[top-1];stack[top-1]=(a&0x80000000u)?0:(a>arg?arg:a);
        } else {
            if(top<2)goto invalid;
            b=stack[--top];a=stack[--top];
            if(op!=13&&arg)goto invalid;
            switch(op) {
                case 5:value=a+b;break;case 6:value=a-b;break;case 7:value=a*b;break;
                case 8:value=a^b;break;case 9:value=a&b;break;case 10:value=a|b;break;
                case 11:if(b>=32)goto invalid;value=a<<b;break;
                case 12:if(b>=32)goto invalid;value=a>>b;break;
                case 13:if(arg>2)goto invalid;if(!interpret(e,arg,a,b,0,2,&value))goto cleanup;break;
                default:goto invalid;
            }
            stack[top++]=value;
        }
    }
invalid:
    e->error="Invalid native bytecode instruction.";
cleanup:
    wipe(plain,sizeof(plain));wipe(regs,sizeof(regs));wipe(stack,sizeof(stack));wipe(seed,sizeof(seed));wipe(digest,sizeof(digest));
    if(entered){e->active&=~(1u<<id);e->depth--;}
    return success;
}

static PyObject *run(PyObject *self, PyObject *args) {
    (void)self;PyObject *handle,*keys;unsigned x,y,z;
    if(!PyArg_ParseTuple(args,"OOIII",&handle,&keys,&x,&y,&z))return NULL;
    Image *image=PyCapsule_GetPointer(handle,"mirage.vm.v2");if(!image)return NULL;
    if(!PyTuple_Check(keys)||PyTuple_GET_SIZE(keys)!=MAX_REGIONS){PyErr_SetString(PyExc_ValueError,"Invalid native decode material.");return NULL;}
    Execution execution={.image=image,.budget=1024};
    for(unsigned i=0;i<MAX_REGIONS;i++){
        PyObject *key=PyTuple_GET_ITEM(keys,i);
        if(!PyBytes_Check(key)||PyBytes_GET_SIZE(key)!=32){PyErr_SetString(PyExc_ValueError,"Invalid model material width.");return NULL;}
        execution.keys[i]=(const uint8_t*)PyBytes_AS_STRING(key);
    }
    uint32_t result;
    /* Keep the GIL: one short activation is atomic with respect to Python installation. */
    if(!interpret(&execution,3,x,y,z,3,&result)){PyErr_SetString(PyExc_RuntimeError,execution.error);return NULL;}
    return Py_BuildValue("II",result,execution.maximum);
}

/* Fixed-shape, float32 inference for the exported 764,544-parameter transformer. */
enum { D=128, H=512, L=4, HEADS=4, KVHEADS=2, HD=32, KV=64, VOCAB=166, CONTEXT=160, PARAMETERS=764544,
       ROTARY=CONTEXT*HD, MODEL_FLOATS=PARAMETERS+2*ROTARY, MODEL_BYTES=16+4*MODEL_FLOATS };
typedef struct { float *an,*qkv,*proj,*mn,*up,*down; } Layer;
typedef struct {
    uint8_t *storage; float *embedding,*norm,*head,*sin,*cos; Layer layers[L];
    float keys[L][CONTEXT][KV],values[L][CONTEXT][KV]; unsigned position; int busy;
} Model;
static void model_free(PyObject *capsule) {Model *m=PyCapsule_GetPointer(capsule,"mirage.model.v1");if(m){wipe(m->storage,MODEL_BYTES);PyMem_Free(m->storage);wipe(m,sizeof(*m));PyMem_Free(m);}}
static void matvec(float *out,const float *w,const float *x,int rows,int cols){cblas_sgemv(CblasRowMajor,CblasNoTrans,rows,cols,1.0f,w,cols,x,1,0.0f,out,1);}
static void rms(float *out,const float *x,const float *weight){float sum=0;for(int i=0;i<D;i++)sum+=x[i]*x[i];float scale=1.0f/sqrtf(sum/(float)D+1e-4f);for(int i=0;i<D;i++)out[i]=x[i]*scale*weight[i];}
static void rotary(float *x,const Model *m,unsigned position,int heads){
    for(int h=0;h<heads;h++)for(int i=0;i<HD/2;i++){
        int a=h*HD+i,b=a+HD/2;float left=x[a],right=x[b];unsigned p=position*HD+(unsigned)i;
        x[a]=left*m->cos[p]-right*m->sin[p];
        x[b]=right*m->cos[p+HD/2]+left*m->sin[p+HD/2];
    }
}
static void model_token(Model *m,unsigned token,float *hidden,float *logits,int emit){
    float x[D],norm[D],qkv[D+2*KV],attention[D],project[D],ff[H],scores[CONTEXT];
    memcpy(x,m->embedding+token*D,sizeof(x));unsigned position=m->position;
    for(int layer=0;layer<L;layer++){
        Layer *w=&m->layers[layer];rms(norm,x,w->an);matvec(qkv,w->qkv,norm,D+2*KV,D);
        rotary(qkv,m,position,HEADS);rotary(qkv+D,m,position,KVHEADS);
        memcpy(m->keys[layer][position],qkv+D,KV*sizeof(float));memcpy(m->values[layer][position],qkv+D+KV,KV*sizeof(float));
        for(int h=0;h<HEADS;h++){
            float maximum=-INFINITY;int kh=(h/2)*HD;
            for(unsigned p=0;p<=position;p++){
                float score=cblas_sdot(HD,qkv+h*HD,1,m->keys[layer][p]+kh,1)/sqrtf((float)HD);
                scores[p]=score;if(score>maximum)maximum=score;
            }
            float sum=0;for(unsigned p=0;p<=position;p++){scores[p]=expf(scores[p]-maximum);sum+=scores[p];}
            for(int d=0;d<HD;d++){
                float value=0;for(unsigned p=0;p<=position;p++)value+=(scores[p]/sum)*m->values[layer][p][kh+d];
                attention[h*HD+d]=value;
            }
        }
        matvec(project,w->proj,attention,D,D);for(int i=0;i<D;i++)x[i]+=project[i];
        rms(norm,x,w->mn);matvec(ff,w->up,norm,H,D);
        for(int i=0;i<H;i++)ff[i]=0.5f*ff[i]*(1.0f+erff(ff[i]*0.7071067811865475f));
        matvec(project,w->down,ff,D,H);for(int i=0;i<D;i++)x[i]+=project[i];
    }
    if(emit){rms(hidden,x,m->norm);matvec(logits,m->head,hidden,VOCAB,D);}
    m->position++;
}
static PyObject *model_load(PyObject *self,PyObject *arg){
    (void)self;
    if(!PyBytes_Check(arg)||PyBytes_GET_SIZE(arg)!=MODEL_BYTES||memcmp(PyBytes_AS_STRING(arg),"MIRAMDL1",8)||little32((uint8_t*)PyBytes_AS_STRING(arg)+8)!=PARAMETERS||little32((uint8_t*)PyBytes_AS_STRING(arg)+12)!=ROTARY){PyErr_SetString(PyExc_ValueError,"Invalid native transformer format.");return NULL;}
    Model *m=PyMem_Calloc(1,sizeof(*m));if(!m)return PyErr_NoMemory();
    m->storage=PyMem_Malloc(MODEL_BYTES);if(!m->storage){PyMem_Free(m);return PyErr_NoMemory();}
    memcpy(m->storage,PyBytes_AS_STRING(arg),MODEL_BYTES);
    float *p=(float*)(m->storage+16);
    for(unsigned i=0;i<MODEL_FLOATS;i++)if(!isfinite(p[i])){PyMem_Free(m->storage);PyMem_Free(m);PyErr_SetString(PyExc_ValueError,"Nonfinite model weight.");return NULL;}
    m->embedding=p;p+=VOCAB*D;
    for(int i=0;i<L;i++){Layer *w=&m->layers[i];w->an=p;p+=D;w->qkv=p;p+=(D+2*KV)*D;w->proj=p;p+=D*D;w->mn=p;p+=D;w->up=p;p+=H*D;w->down=p;p+=D*H;}
    m->norm=p;p+=D;m->head=p;p+=VOCAB*D;m->sin=p;p+=ROTARY;m->cos=p;
    return PyCapsule_New(m,"mirage.model.v1",model_free);
}
static PyObject *model_forward(PyObject *self,PyObject *args){
    (void)self;PyObject *handle,*ids;int reset;
    if(!PyArg_ParseTuple(args,"OOp",&handle,&ids,&reset))return NULL;
    Model *m=PyCapsule_GetPointer(handle,"mirage.model.v1");if(!m)return NULL;
    PyObject *sequence=PySequence_Fast(ids,"Expected token identifiers.");if(!sequence)return NULL;
    Py_ssize_t n=PySequence_Fast_GET_SIZE(sequence);unsigned start=reset?0:m->position,tokens[CONTEXT];
    if(m->busy||n<1||n>CONTEXT||start+(unsigned)n>CONTEXT){Py_DECREF(sequence);PyErr_SetString(PyExc_ValueError,"Invalid or concurrent model context.");return NULL;}
    for(Py_ssize_t i=0;i<n;i++){
        unsigned long id=PyLong_AsUnsignedLong(PySequence_Fast_GET_ITEM(sequence,i));
        if(PyErr_Occurred()){Py_DECREF(sequence);return NULL;}
        if(id>=VOCAB){Py_DECREF(sequence);PyErr_SetString(PyExc_ValueError,"Unknown model token.");return NULL;}tokens[i]=(unsigned)id;
    }
    Py_DECREF(sequence);float hidden[D],logits[VOCAB];m->position=start;m->busy=1;
    Py_BEGIN_ALLOW_THREADS
    for(Py_ssize_t i=0;i<n;i++)model_token(m,tokens[i],hidden,logits,i+1==n);
    Py_END_ALLOW_THREADS
    m->busy=0;
    PyObject *out=PyList_New(VOCAB),*state=PyList_New(D);if(!out||!state){Py_XDECREF(out);Py_XDECREF(state);return NULL;}
    for(int i=0;i<VOCAB;i++)PyList_SET_ITEM(out,i,PyFloat_FromDouble(logits[i]));
    for(int i=0;i<D;i++)PyList_SET_ITEM(state,i,PyFloat_FromDouble(hidden[i]));
    return Py_BuildValue("NIN",out,m->position,state);
}
static PyObject *model_evolve(PyObject *self,PyObject *args){
    (void)self;PyObject *handle;unsigned epoch;
    if(!PyArg_ParseTuple(args,"OI",&handle,&epoch))return NULL;Model *m=PyCapsule_GetPointer(handle,"mirage.model.v1");if(!m)return NULL;
    if(m->busy){PyErr_SetString(PyExc_RuntimeError,"Model inference is active.");return NULL;}
    unsigned i=epoch%D;m->norm[i]*=-1;for(int row=0;row<VOCAB;row++)m->head[row*D+i]*=-1;Py_RETURN_NONE;
}
static PyObject *model_state(PyObject *self,PyObject *handle){
    (void)self;Model *m=PyCapsule_GetPointer(handle,"mirage.model.v1");if(!m)return NULL;
    if(m->busy){PyErr_SetString(PyExc_RuntimeError,"Model inference is active.");return NULL;}
    return PyBytes_FromStringAndSize((char*)m->norm,(D+VOCAB*D)*sizeof(float));
}
static PyObject *model_set_state(PyObject *self,PyObject *args){
    (void)self;PyObject *handle,*state;if(!PyArg_ParseTuple(args,"OO",&handle,&state))return NULL;
    Model *m=PyCapsule_GetPointer(handle,"mirage.model.v1");if(!m)return NULL;
    if(m->busy||!PyBytes_Check(state)||PyBytes_GET_SIZE(state)!=(D+VOCAB*D)*sizeof(float)){PyErr_SetString(PyExc_ValueError,"Invalid model state.");return NULL;}
    memcpy(m->norm,PyBytes_AS_STRING(state),(D+VOCAB*D)*sizeof(float));Py_RETURN_NONE;
}
static PyObject *model_dump(PyObject *self,PyObject *handle){
    (void)self;Model *m=PyCapsule_GetPointer(handle,"mirage.model.v1");if(!m)return NULL;
    if(m->busy){PyErr_SetString(PyExc_RuntimeError,"Model inference is active.");return NULL;}
    return PyBytes_FromStringAndSize((char*)m->storage,MODEL_BYTES);
}

static PyMethodDef methods[]={
    {"prepare",prepare,METH_O,"Copy immutable encrypted region buffers."},{"run",run,METH_VARARGS,"Decode and execute one nested application call."},
    {"model_load",model_load,METH_O,"Load fixed-shape float32 model weights."},{"model_forward",model_forward,METH_VARARGS,"Run transformer inference with an internal KV cache."},
    {"model_evolve",model_evolve,METH_VARARGS,"Evolve model representation."},{"model_state",model_state,METH_O,"Read evolving model state."},
    {"model_set_state",model_set_state,METH_VARARGS,"Restore evolving model state."},{"model_dump",model_dump,METH_O,"Export model weights."},
    {NULL,NULL,0,NULL}};
static struct PyModuleDef module={PyModuleDef_HEAD_INIT,"_mirage_native",NULL,-1,methods};
PyMODINIT_FUNC PyInit__mirage_native(void){return PyModule_Create(&module);}
